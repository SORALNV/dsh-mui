import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parse, stringify } from 'yaml';
import { DshClient } from './dsh-api.mjs';

export const defaults = Object.freeze({ enabled: false, provider: 'opencode-free', model: 'deepseek-v4.1-flash-free' });
const validId = s => typeof s === 'string' && /^[\w.-]{1,128}$/.test(s);
const readJson = async (path, fallback) => {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
};
const sha = s => createHash('sha256').update(s).digest('hex');
class LoaderExpression {
  constructor(source) { this.source = source; }
}
const yamlOptions = { customTags: [{
  tag: 'tag:yaml.org,2002:js',
  identify: value => value instanceof LoaderExpression,
  resolve: source => new LoaderExpression(source),
  stringify: ({ value }, ctx, onComment, onChompKeep) => {
    // A JSON double-quoted scalar is valid YAML and retains the expression verbatim.
    return JSON.stringify(value.source);
  },
}] };
const home = () => resolve(process.env.DSH_HOME || join(homedir(), '.dsh'));
const statePath = () => join(homedir(), '.dsh', 'mui-daemon.json');
const runtime = () => process.env.MUI_DSH_CLI || process.env.DSH_BIN || 'dsh';
const local = origin => {
  const u = new URL(origin);
  return ['http:', 'https:'].includes(u.protocol) && ['127.0.0.1', '[::1]', 'localhost'].includes(u.hostname) && u.origin === origin;
};
function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}
async function profilePaths(profile) {
  const daemon = await readJson(statePath(), null);
  const running = alive(daemon?.pid) ? daemon : null;
  profile ??= running?.profile ?? 'web';
  if (!validId(profile) || profile === '.' || profile === '..') throw new Error('Invalid DSH profile name');
  const root = home();
  const dir = join(root, 'mui-compaction', profile);
  return { root, profile, profileDir: join(root, 'profiles', profile), dir, settings: join(dir, 'settings.json'), diagnostic: join(dir, 'diagnostic.json'), running: running?.profile === profile ? running : null };
}
async function atomic(path, text) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temp, text, { mode: 0o600, flag: 'wx' }); await rename(temp, path); }
  finally { await rm(temp, { force: true }); }
}
const json = x => JSON.stringify(x, null, 2) + '\n';
function settingsOf(saved) {
  if (!saved) return { ...defaults };
  if (saved.version !== 1 || typeof saved.enabled !== 'boolean' || !validId(saved.provider) || !validId(saved.model)) throw new Error('Invalid Compaction Manager settings');
  return { enabled: saved.enabled, provider: saved.provider, model: saved.model };
}
const exec = promisify(execFile);
async function dump(profile, env, overlay) {
  let stdout;
  try { ({ stdout } = await exec(runtime(), ['--profile', profile, '--dump-config', ...(overlay ? ['--patch', overlay] : [])], { env, encoding: 'utf8', timeout: 15_000, maxBuffer: 16 * 1024 * 1024 })); }
  catch { throw new Error('DSH profile composition failed; no managed configuration changed'); }
  const tree = parse(stdout, yamlOptions);
  if (!Array.isArray(tree)) throw new Error('Unsupported DSH profile composition output');
  return tree;
}
function targets(tree) {
  const found = [];
  function scan(rows, preset) {
    for (const row of rows) {
      if (row?.disabled || !validId(row?.id)) continue;
      const isPreset = row.name === '@deepseek-ai/dsh-agent-preset';
      if (preset && row.name === '@deepseek-ai/dsh-compaction-basic') found.push({ row, preset });
      const slot = isPreset ? row.config?.plugins : row.group === true ? row.config : null;
      if (Array.isArray(slot)) scan(slot, isPreset ? row.config.id : preset);
    }
  }
  scan(tree, null);
  return found;
}
export function makePatch(tree, settings) {
  const selected = targets(tree);
  if (!selected.length) throw new Error('No enabled preset-level dsh-compaction-basic found');
  const route = { summarizationProvider: settings.provider, summarizationModel: settings.model };
  const replacements = new Map(selected.map(({ row }) => {
    const policies = row.config?.modelPolicies;
    if (policies != null && !Array.isArray(policies)) throw new Error('Unsupported DSH modelPolicies schema');
    const config = { ...row.config, ...route };
    if (policies) config.modelPolicies = policies.map(policy => {
      if (!policy || typeof policy !== 'object' || Array.isArray(policy)) throw new Error('Unsupported DSH model policy');
      return { ...policy, ...route };
    });
    return [row, { ...row, config }];
  }));
  function rewrite(rows) {
    return rows.map(row => replacements.get(row) ?? (row.group === true && Array.isArray(row.config)
      ? { ...row, config: rewrite(row.config) } : row));
  }
  // Cordis replaces config atomically; preserve the full preset, not just compaction.
  const patch = tree.filter(row => !row.disabled && row.name === '@deepseek-ai/dsh-agent-preset' && Array.isArray(row.config?.plugins) && selected.some(x => x.preset === row.config.id))
    .map(row => ({ id: row.id, config: { ...row.config, plugins: rewrite(row.config.plugins) } }));
  if (!patch.length) throw new Error('Unsupported preset layout');
  return { patch, presets: selected.map(x => x.preset) };
}
async function compose(paths, settings) {
  const temp = await mkdtemp(join(tmpdir(), 'mui-compaction-'));
  try {
    const dir = join(temp, 'profiles', paths.profile);
    await mkdir(dir, { recursive: true });
    for (const [source, dest, optional] of [
      [join(paths.profileDir, 'package.json'), join(dir, 'package.json'), false],
      [join(paths.profileDir, 'cordis.patch.yml'), join(dir, 'cordis.patch.yml'), true],
      [join(paths.root, 'cordis.patch.yml'), join(temp, 'cordis.patch.yml'), true],
    ]) {
      try { await copyFile(source, dest); } catch (e) { if (!optional || e.code !== 'ENOENT') throw e; }
    }
    await symlink(join(paths.profileDir, 'node_modules'), join(dir, 'node_modules'), 'dir');
    const env = { ...process.env, DSH_HOME: temp };
    const version = spawnSync(runtime(), ['--version'], { env, encoding: 'utf8', timeout: 5000 }).stdout?.trim();
    if (version !== '0.2.2-rc.1') throw new Error('Unsupported DSH version; review compaction compatibility before enabling');
    const tree = await dump(paths.profile, env);
    const { patch, presets } = makePatch(tree, settings);
    const text = stringify(patch, { ...yamlOptions, lineWidth: 0 });
    const candidate = join(temp, 'candidate.patch.yml');
    await writeFile(candidate, text);
    const composed = await dump(paths.profile, env, candidate);
    const expected = tree.map(row => {
      const update = patch.find(entry => entry.id === row.id);
      return update ? { ...row, config: update.config } : row;
    });
    if (JSON.stringify(composed) !== JSON.stringify(expected)) throw new Error('DSH changed additional configuration during composition');
    const effective = targets(composed);
    if (effective.length !== presets.length || effective.some(({ row }) => {
      const good = x => x.summarizationProvider === settings.provider && x.summarizationModel === settings.model;
      return !good(row.config ?? {}) || Object.values(row.config?.modelPolicies ?? {}).some(x => !good(x));
    })) throw new Error('DSH did not resolve the requested compression model in every targeted preset');
    return { text, presets, version };
  } finally { await rm(temp, { recursive: true, force: true }); }
}
async function sync(paths, settings) {
  if (!settings.enabled) return { overlay: null, digest: null, presets: [] };
  const { text, presets, version } = await compose(paths, settings);
  const digest = sha(text);
  const overlay = join(paths.dir, `${digest}.patch.yml`);
  if (await readFile(overlay, 'utf8').catch(e => { if (e.code !== 'ENOENT') throw e; }) !== text) await atomic(overlay, text);
  return { overlay, digest, presets, version };
}
export async function startupCompaction(profile, { extra = [] } = {}) {
  const paths = await profilePaths(profile);
  const settings = settingsOf(await readJson(paths.settings, null));
  if (settings.enabled && extra.some(arg => /^--(?:patch|profile|from-default-profile)(?:=|$)/.test(arg))) {
    throw new Error('起動引数のプロファイル／パッチ指定との併用は未対応です');
  }
  return sync(paths, settings);
}
async function freeInference(settings) {
  if (settings.provider !== 'opencode-free') return { ok: false, reason: 'Only the verified free OpenCode route can be probed without risking charges' };
  const temp = await mkdtemp(join(tmpdir(), 'mui-compaction-probe-'));
  try {
    const env = { PATH: process.env.PATH, HOME: temp, XDG_CONFIG_HOME: join(temp, 'config'), XDG_CACHE_HOME: join(temp, 'cache'), XDG_DATA_HOME: join(temp, 'data'), XDG_STATE_HOME: join(temp, 'state'), OPENCODE_DISABLE_AUTOUPDATE: 'true', OPENCODE_DISABLE_PROJECT_CONFIG: 'true', OPENCODE_CONFIG_CONTENT: JSON.stringify({ autoupdate: false, permission: { '*': 'deny' } }) };
    const { stdout } = await promisify(execFile)('opencode', ['run', '--standalone', '--archived', '--format', 'json', '--model', `opencode/${settings.model}`, 'Reply with exactly the single word MUIREADY. Do not use tools.'], { cwd: temp, env, timeout: 90_000, maxBuffer: 1024 * 1024 });
    const events = stdout.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
    const text = events.filter(e => e.type === 'text').map(e => e.part?.text ?? '').join('');
    const ok = !events.some(e => e.type === 'error') && text.trim() === 'MUIREADY';
    return { ok, ...(ok ? {} : { reason: 'The free model did not return the expected probe response' }) };
  } catch { return { ok: false, reason: 'OpenCode free inference failed or timed out' }; }
  finally { await rm(temp, { recursive: true, force: true }); }
}
async function diagnose(paths, settings) {
  const opencode = spawnSync('opencode', ['--version'], { encoding: 'utf8', timeout: 5000 });
  const manifest = await readJson(join(paths.profileDir, 'package.json'), {});
  const dependencies = { ...manifest.devDependencies, ...manifest.dependencies };
  const plugin = Object.entries(dependencies).find(([name]) => name.includes('deep-opencode'));
  let pluginInstalled = null;
  if (plugin) pluginInstalled = (await readJson(join(paths.profileDir, 'node_modules', plugin[0], 'package.json'), null))?.version ?? null;
  let connection = 'not-running', available = false, models = [], contextWindow = null;
  if (paths.running && local(paths.running.origin)) {
    try {
      const c = new DshClient({ ...paths.running, fetchImpl: (url, options) => fetch(url, { ...options, redirect: 'manual', signal: AbortSignal.timeout(8000) }) });
      const catalog = await c.modelCatalog();
      const group = catalog.groups?.find(g => g.id === settings.provider);
      models = group?.models?.map(m => m.id) ?? [];
      const model = group?.models?.find(m => m.id === settings.model);
      available = !!model && catalog.routableProviders?.includes(settings.provider) === true;
      contextWindow = model?.context?.contextWindow ?? model?.contextWindow ?? null;
      connection = available ? 'catalog-available' : 'model-unavailable';
    } catch { connection = 'unreachable'; }
  }
  let contextSource = contextWindow ? 'dsh-catalog' : null;
  if (!contextWindow && available && settings.provider === 'opencode-free') {
    try {
      const res = await fetch('https://models.dev/api.json', { signal: AbortSignal.timeout(5000), redirect: 'error' });
      const entry = res.ok ? (await res.json())?.opencode?.models?.[settings.model] : null;
      const limit = entry?.limit?.context;
      if (Number.isSafeInteger(limit) && limit > 0) {
        contextWindow = limit;
        contextSource = 'models.dev-reference';
      }
    } catch { /* capacity is advisory; the live DSH catalog remains authoritative for routing */ }
  }
  let compatibility;
  try { const r = await compose(paths, settings); compatibility = { ok: true, version: r.version, presets: r.presets }; }
  catch (e) { compatibility = { ok: false, error: e.message }; }
  return { at: new Date().toISOString(), opencode: opencode.status === 0 ? opencode.stdout.trim() : null, plugin: plugin ? { name: plugin[0], requested: plugin[1], installed: pluginInstalled } : null, connection, available, models, contextWindow, contextSource, compatibility };
}
export async function manage(action, args = [], { profile } = {}) {
  const paths = await profilePaths(profile);
  if (['status', 'doctor', 'test'].includes(action)) return manageProfile(paths, action, args);
  await mkdir(paths.dir, { recursive: true, mode: 0o700 });
  const lock = join(paths.dir, 'settings.lock');
  try { await mkdir(lock); }
  catch (e) { if (e.code === 'EEXIST') throw new Error('Another compaction settings update is in progress'); throw e; }
  try { return await manageProfile(paths, action, args); }
  finally { await rm(lock, { recursive: true, force: true }); }
}
async function manageProfile(paths, action, args) {
  const previous = await readJson(paths.settings, null);
  let s = settingsOf(previous);
  const result = (more = {}) => {
    const desired = Object.hasOwn(more, 'digest') ? more.digest : previous?.digest ?? null;
    const current = paths.running?.compactionDigest ?? null;
    return { profile: paths.profile, ...s, applied: s.enabled && current !== null && current === desired,
      restartRequired: !!paths.running && (current !== desired || (s.enabled && current === null)), ...more };
  };
  if (action === 'status') {
    const last = await readJson(paths.diagnostic, null);
    return result({ lastDiagnosis: last?.provider === s.provider && last?.model === s.model ? last : null });
  }
  if (action === 'doctor' || action === 'test') {
    const diagnostic = { provider: s.provider, model: s.model, ...(await diagnose(paths, s)) };
    if (action === 'test') diagnostic.probe = diagnostic.available && diagnostic.compatibility.ok
      ? await freeInference(s) : { ok: false, reason: 'Catalog or compatibility check failed; no inference sent' };
    await atomic(paths.diagnostic, json(diagnostic));
    return result({ diagnostic, ok: diagnostic.available && diagnostic.compatibility.ok && (diagnostic.probe?.ok ?? true) });
  }
  if (action === 'set') {
    if (args.length !== 2 || !args.every(validId)) throw new Error('Usage: mui compaction set <provider> <model>');
    s = { ...s, provider: args[0], model: args[1] };
  } else if (action === 'enable') s = { ...s, enabled: true };
  else if (action === 'disable') s = { ...s, enabled: false };
  else if (action === 'rollback') {
    if (!previous?.rollback) throw new Error('No previous compaction settings to restore');
    s = settingsOf(previous.rollback);
  } else if (action !== 'sync') throw new Error('Usage: mui compaction status|enable|disable|set|doctor|test|sync|rollback');
  const synced = await sync(paths, s);
  const prior = settingsOf(previous);
  const changed = json(prior) !== json(s);
  const next = { version: 1, ...s, digest: synced.digest, ...(changed ? { rollback: { version: 1, ...prior } } : previous?.rollback ? { rollback: previous.rollback } : {}) };
  if (json(previous) !== json(next)) await atomic(paths.settings, json(next));
  return result(synced);
}
