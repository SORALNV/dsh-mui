#!/usr/bin/env node
// Opt-in live test: node test/compaction-live.mjs
// Offline native test (no network inference): node test/compaction-live.mjs --fixture
// Uses the installed dsh-deep-opencode package as read-only input; never attaches to a running DSH.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, lstat, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join, sep } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { DshClient, contentText } from '../lib/dsh-api.mjs';
import { defaults, manage, startupCompaction } from '../lib/compaction.mjs';

const offline = process.argv.includes('--fixture');
const provider = offline ? 'smoke-fixture' : defaults.provider;
const model = offline ? 'summary' : process.env.MUI_COMPACTION_TEST_MODEL ?? defaults.model;
const conversation = offline ? 'wide' : model;
const count = offline ? 2400 : 2600;
const thresholdRatio = offline ? 0.6 : 0.009;
const source = process.env.MUI_COMPACTION_TEST_PROVIDER ?? join(homedir(), '.dsh/profiles/web/node_modules/dsh-deep-opencode');
const cli = process.env.MUI_DSH_CLI ?? 'dsh';
const originalCwd = process.cwd();
const temporaryParent = await realpath(tmpdir());
const root = await realpath(await mkdtemp(join(temporaryParent, 'mui-compaction-live-')));
const profile = 'compaction-smoke';
const dshHome = join(root, 'dsh');
const work = join(root, 'work');
const userHome = join(root, 'home');
const timeout = 115_000;
let child, logs = '', exited;
const signal = new AbortController();
for (const name of ['SIGINT', 'SIGTERM']) process.once(name, () => signal.abort(new Error(name)));

class TestClient extends DshClient {
  constructor(url) {
    super({ origin: url.origin, token: url.searchParams.get('token'), fetchImpl: (url, options) => fetch(url, {
      ...options, redirect: 'manual', signal: AbortSignal.any([signal.signal, AbortSignal.timeout(timeout)]),
    }) });
  }
  async compact(id) {
    const res = await this.fetch(`${this.origin}/api/commands/execute`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: this.cookie ?? await this.auth() },
      body: JSON.stringify({ type: 'client-request', rpcId: 'compact-smoke', method: 'commands/execute',
        payload: { args: { agentId: id, line: '/compact', submittedAttachments: [] } } }),
    });
    const { result } = await res.json();
    assert.ok(result?.ok, JSON.stringify(result));
    return result.value;
  }
}

async function waitFor(check, label, ms = timeout) {
  const deadline = Date.now() + ms;
  do {
    signal.signal.throwIfAborted();
    if (exited) throw new Error(`isolated DSH exited: ${exited}`);
    const result = await check();
    if (result) return result;
    await sleep(250, undefined, { signal: signal.signal });
  } while (Date.now() < deadline);
  throw new Error(`Timed out: ${label}`);
}

function fixture(seed, count) {
  // Long, deterministic, relatively incompressible generated records. No files or history are read.
  let x = seed;
  return Array.from({ length: count }, () => {
    x = (Math.imul(1664525, x) + 1013904223) >>> 0;
    return x.toString(16).padStart(8, '0');
  }).join(' ');
}

function preset(id, config) {
  return { id: `preset-${id}`, name: '@deepseek-ai/dsh-agent-preset', config: { id, plugins: [
    { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: 'You are testing synthetic fixture data. Do not use tools.', complete: true, includeRuntimeContext: false } },
    { id: 'compaction', name: 'cordis:group', group: true, isolate: { compaction: true }, config: [
      { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic', config: { retainTokens: 192, headroomTokens: 0, maxTokens: 4096, ...config } },
      { id: 'command-compact', name: '@deepseek-ai/dsh-command-compact' },
    ] },
  ] } };
}

async function executablePath() {
  for (const p of cli.includes(sep) ? [cli] : (process.env.PATH ?? '').split(delimiter).map(dir => join(dir, cli))) {
    try { return await realpath(p); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  throw new Error(`Cannot resolve CLI executable ${cli}`);
}

async function installFixture(path) {
  const llmModule = createRequire(await executablePath()).resolve('@deepseek-ai/dsh-llm');
  await writeFile(path, `import { LlmAdapter } from ${JSON.stringify(llmModule)};
export const name = 'smoke-fixture';
export const inject = ['llm'];
const provider = 'smoke-fixture';
class Fixture extends LlmAdapter {
  async resolveModel(provider, model) {
    return { id: model, name: model, provider, defaultMaxTokens: 256,
      context: { contextWindow: model === 'wide' ? 32768 : 16384 } };
  }
  async listModels(provider) { return Promise.all(['wide', 'narrow', 'summary'].map(model => this.resolveModel(provider, model))); }
  async *stream(options) {
    options.signal?.throwIfAborted();
    const isSummary = options.purpose === 'compaction';
    if (isSummary !== (options.model === 'summary')) throw new Error('Unexpected fixture route: ' + options.model);
    const replies = options.messages.filter(m => m.role === 'user').flatMap(m => m.content)
      .map(p => p.text?.match(/Reply with only (SMOKE-[A-Z0-9]+)/)?.[1]).filter(Boolean);
    if (isSummary && replies.includes('SMOKE-OVERFLOW')) throw new Error('synthetic summary context capacity exceeded');
    const text = isSummary ? 'Synthetic checkpoint: deterministic test records and their acknowledgements.' : replies.at(-1);
    if (!text) throw new Error('Missing generated marker');
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text };
    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}
export function apply(ctx) { ctx.effect(() => ctx.llm.registerAdapter([provider], new Fixture())); }
`);
}

async function test() {
  const dir = join(dshHome, 'profiles', profile);
  const modules = join(dir, 'node_modules');
  await Promise.all([mkdir(modules, { recursive: true }), mkdir(work), mkdir(userHome)]);
  // Copy only the provider package, not the production profile, patch, credentials, or sessions.
  const fixturePath = join(root, 'smoke-fixture.mjs');
  const webBundle = '@mui/compaction-manager';
  const webSource = fileURLToPath(new URL('../plugins/compaction-manager/', import.meta.url));
  if (offline) {
    await installFixture(fixturePath);
    await cp(webSource, join(modules, webBundle), { recursive: true });
  } else {
    const installed = await realpath(source);
    await cp(installed, join(modules, 'dsh-deep-opencode'), {
      recursive: true,
      filter: async p => !['node_modules', '.git'].includes(p.split(sep).at(-1)) && !(await lstat(p)).isSymbolicLink(),
    });
  }
  // Preserve only binary resolution and network environment; no auth credentials/config or tool tokens.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|LANG|LC_\w+|https?_proxy|all_proxy|no_proxy|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR)$/i.test(key)));
  Object.assign(env, {
    HOME: userHome, USERPROFILE: userHome, DSH_HOME: dshHome, TMPDIR: root,
    MUI_COMPACTION_MANAGER_MODULE: fileURLToPath(new URL('../lib/compaction.mjs', import.meta.url)),
    MUI_COMPACTION_MANAGER_PROFILE: profile,
    XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'),
    XDG_CACHE_HOME: join(root, 'cache'), XDG_STATE_HOME: join(root, 'state'),
    OPENCODE_DISABLE_AUTOUPDATE: 'true', OPENCODE_DISABLE_PROJECT_CONFIG: 'true',
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: { '*': 'deny' }, autoupdate: false }),
  });
  // The manager itself spawns DSH for config dumps, so isolate those children too.
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, env, { MUI_DSH_CLI: cli });
  process.chdir(work);
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'dsh-profile-compaction-smoke', private: true,
    dependencies: offline ? { [webBundle]: '0.1.0' } : { 'dsh-deep-opencode': '0.1.0' }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', offline ? webBundle : 'dsh-deep-opencode'] } } }));
  const configure = async (alternate) => {
    const patches = [
      { id: 'session-title-llm', disabled: true }, { id: 'llm-retry', disabled: true },
      ...(offline ? [] : [{ id: 'deep-opencode', config: { bridgeHarnessTools: false, reuseSessions: false, turnTimeoutMs: 75000 } }]),
      { insert: [...(offline ? [{ id: 'smoke-fixture', name: fixturePath }] : []),
        preset('smoke-manual', { auto: false }), preset('smoke-auto', { thresholdRatio: offline ? 0.16 : thresholdRatio }),
        ...(alternate ? [preset('smoke-switch', { modelPolicies: [{ provider, model: alternate, thresholdRatio }] })] : [])] },
    ];
    await writeFile(join(dir, 'cordis.patch.yml'), JSON.stringify(patches));
    await manage('set', [provider, model], { profile });
    const enabled = await manage('enable', [], { profile });
    const started = await startupCompaction(profile);
    assert.equal(enabled.digest, started.digest);
    assert.ok(started.overlay?.startsWith(dshHome + sep));
    console.log(`PASS manager overlay ${started.digest.slice(0, 12)} (${started.presets.join(', ')})`);
    return started.overlay;
  };
  const boot = async (overlay) => {
    logs = ''; exited = undefined;
    child = spawn(cli, ['--profile', profile, '--patch', overlay, '--no-open', '--host', '127.0.0.1', '--port', '0'],
      { cwd: work, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    child.on('error', e => { exited = e.message; });
    child.on('exit', (code, sig) => { exited = `${code ?? sig}`; });
    for (const stream of [child.stdout, child.stderr]) stream.setEncoding('utf8').on('data', chunk => { logs += chunk; });
    const url = await waitFor(() => {
      const matches = logs.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[\w.~-]+)/);
      return matches && new URL(matches[1]);
    }, 'private loopback web startup', 30_000);
    const client = new TestClient(url);
    await client.auth();
    return client;
  };
  let c = await boot(await configure());
  if (offline) {
    const rpc = async (endpoint, payload, authenticated = true) => c.fetch(`${c.origin}/api/mui-compaction-manager`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...(authenticated ? { cookie: c.cookie ?? await c.auth() } : {}) },
      body: JSON.stringify({ action: endpoint, args: payload }),
    });
    const unauthenticated = await rpc('getStatus', {}, false);
    assert.equal(unauthenticated.ok, false);
    const status = await (await rpc('getStatus', {})).json();
    assert.equal(status?.value?.model, model, JSON.stringify(status));
    assert.equal((await (await rpc('disable', {})).json()).value?.enabled, false);
    assert.equal((await (await rpc('rollback', {})).json()).value?.enabled, true);
    console.log('PASS native Web owner RPC authentication, status, disable and rollback');
  }
  const catalog = await c.modelCatalog();
  const models = catalog.groups?.find(g => g.id === provider)?.models ?? [];
  console.log(`${offline ? 'Fixture' : 'Live'} catalog ${provider}: ${models.map(m => m.id).join(', ')}`);
  assert.ok(catalog.routableProviders?.includes(provider) && models.some(m => m.id === model), `Default ${provider}/${model} is not routable in isolated catalog`);
  const alternate = models.find(m => m.id !== model && m.id !== conversation)?.id;
  const cases = [];
  const run = async (label, fn) => {
    try { await fn(); }
    catch (err) { cases.push(label); process.exitCode = 1; console.error(`FAIL ${label}: ${err.message}`); }
  };
  const events = async id => (await c.pageEvents(id, { maxMessages: 100 })).records.map(r => r.event ?? r);
  const make = async id => {
    const s = await c.call('session/create', { cwd: work, agentPreset: `smoke-${id}` });
    assert.equal(s.agentPreset, `smoke-${id}`);
    await c.selectModel(s.sessionId, provider, conversation);
    return s.sessionId;
  };
  const turn = async (id, label, count = 0) => {
    const prior = await events(id);
    const seq = prior.at(-1)?.seq ?? -1;
    const marker = `SMOKE-${label}`;
    await c.prompt(id, `Generated synthetic catalog test ${label}. Do not use tools. Reply with only ${marker}.\n${fixture(label.length + count, count)}`);
    const added = await waitFor(async () => {
      const ev = (await events(id)).filter(e => e.seq > seq);
      return ev.some(e => e.type === 'turn/end') && ev;
    }, `turn ${label}`);
    const reply = added.filter(e => e.type === 'assistant/message').map(e => contentText(e.data.message?.content)).join('\n');
    const errors = added.filter(e => /error/.test(e.type)).map(e => e.data);
    assert.ok(reply.includes(marker), `no reply containing ${marker}: ${JSON.stringify(errors).slice(0, 700)}; end=${JSON.stringify(added.at(-1)?.data)}`);
    console.log(`PASS ${offline ? 'fixture' : 'live'} reply ${marker}`);
    return added;
  };
  const checkpoint = (events, trigger) => {
    const summary = events.find(e => e.type === 'compaction/summary');
    const sameId = (e, type) => e.type === type && e.data.compactionId === summary?.data.compactionId;
    const start = events.find(e => sameId(e, 'compaction/start'));
    const end = events.find(e => sameId(e, 'compaction/end'));
    assert.ok(start && summary && end && start.seq < summary.seq && summary.seq < end.seq,
      `no completed compaction: ${JSON.stringify(events.filter(e => e.type?.startsWith('compaction/')).map(e => [e.type, e.data])).slice(0, 800)}`);
    const data = summary.data;
    assert.deepEqual([data.provider, data.model], [provider, model]);
    assert.equal(data.llmStreamCall, true, 'no recorded LLM summarization');
    assert.ok(data.shadowedSeqs?.length > 0 && contentText(data.summary).trim(), 'no useful history summary');
    assert.ok(events.some(e => e.seq > summary.seq && e.seq < end.seq && e.type === 'user/message' && e.data.source?.kind === 'compact-checkpoint'), 'no checkpoint message between summary and end');
    assert.ok(trigger === 'manual' ? data.sourceCommandId : !data.sourceCommandId && start.data.turn, 'unexpected compaction ownership');
    console.log(`PASS ${trigger}: summary seq=${summary.seq}, end seq=${end.seq}, shadowed=${data.shadowedSeqs.length}, route=${data.provider}/${data.model}`);
    return end.seq;
  };
  let inferred = false;
  await run(`${offline ? 'fixture' : 'free inference'} and native manual`, async () => {
    const id = await make('manual');
    await turn(id, 'MANUAL1', 360);
    inferred = true;
    await turn(id, 'MANUAL2', 360);
    const result = await c.compact(id);
    assert.match(JSON.stringify(result), /Compacted \d+ history items/);
    checkpoint(await events(id), 'manual');
  });
  if (inferred && offline) await run('native overflow preserves history', async () => {
    const id = await make('manual');
    await turn(id, 'OVERFLOW', 360);
    await turn(id, 'BEFORE', 360);
    const before = await events(id);
    const result = await c.compact(id);
    assert.equal(result.result?.kind, 'error');
    assert.match(result.result.text, /could not produce a useful summary/);
    const after = await events(id);
    assert.deepEqual(after.slice(0, before.length), before);
    assert.ok(!after.some(e => e.type === 'compaction/summary' || e.data?.source?.kind === 'compact-checkpoint'));
    await turn(id, 'AFTER');
    console.log('PASS failed summary leaves history intact and session usable');
  });
  if (inferred) {
    await run('native auto', async () => {
      const id = await make('auto');
      await turn(id, 'AUTO1', count);
      await turn(id, 'AUTO2', count);
      // Pre-step pressure is measured before the pending prompt is admitted.
      if (!(await events(id)).some(e => e.type === 'compaction/summary')) await turn(id, 'AUTO3');
      checkpoint(await events(id), 'step pressure');
    });
    if (alternate) await run('native model switch', async () => {
      await stop();
      c = await boot(await configure(alternate));
      const id = await make('switch');
      await turn(id, 'SWITCH1', count);
      await turn(id, 'SWITCH2', count);
      assert.ok(!(await events(id)).some(e => e.type === 'compaction/summary'), 'history already compacted before model switch');
      await c.selectModel(id, provider, alternate);
      const switched = await turn(id, 'SWITCH3');
      const endSeq = checkpoint(switched, 'model switch');
      assert.ok(switched.some(e => e.seq > endSeq && e.type === 'request/header' && e.data.header?.config?.model === alternate), 'new request header did not follow switch compaction');
      console.log(`PASS request header switched to ${provider}/${alternate} after compaction`);
    });
    else console.log('SKIP model switch: no second cataloged model');
  } else console.log('BLOCKED auto and switch: initial inference did not complete');
  if (cases.length) diagnostics();
}

function diagnostics() {
  console.error(logs.replace(/([?&]token=)[\w.~-]+/g, '$1[redacted]').split('\n').slice(-25).join('\n'));
}

async function stop() {
  if (!child?.pid) return;
  const running = child;
  child = undefined;
  const close = once(running, 'close');
  const send = sig => { try { process.kill(-running.pid, sig); } catch (e) { if (e.code !== 'ESRCH') throw e; } };
  send('SIGTERM');
  if (!exited) await Promise.race([close, sleep(4_000, undefined, { ref: false })]);
  send('SIGKILL');
}

try { await test(); }
catch (err) { process.exitCode = 1; console.error(`FAIL: ${err.stack}`); diagnostics(); }
finally {
  await stop();
  process.chdir(originalCwd);
  assert.equal(dirname(root), temporaryParent);
  assert.match(root.split(sep).at(-1), /^mui-compaction-live-[\w-]+$/);
  await rm(root, { recursive: true, force: true });
}
