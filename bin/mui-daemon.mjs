#!/usr/bin/env node
// mui-daemon — run a DSH host detached as the MUI session core.
//
//   mui-daemon start [--port 3219] [--profile web] [-- <extra dsh args>]
//   mui-daemon status | stop | url | log
//
// The daemon owns sessions; faces attach to it:
//   - browser:  the printed tokenized URL
//   - terminal: mui-view (attach over the same /api bridge)
//   - remote:   mui-forward (cloudflared / tailscale in front of the daemon)

import { spawn, spawnSync } from 'node:child_process';
import { open, readFile, writeFile, rm, stat, appendFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOME = join(homedir(), '.dsh');
const STATE = join(HOME, 'mui-daemon.json');
const LOG = join(HOME, 'mui-daemon.log');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const has = (name) => process.argv.includes(name);
const command = process.argv[2] ?? 'status';

async function readState() {
  try {
    return JSON.parse(await readFile(STATE, 'utf8'));
  } catch {
    return undefined;
  }
}

async function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function writeState(state) {
  await writeFile(STATE, JSON.stringify(state, null, 2) + '\n');
}

// Provider keys are often set with `launchctl setenv` (GUI-layer env) and are
// therefore absent from a shell-spawned daemon. Pull them from launchd so the
// daemon can route through those providers.
const PROVIDER_KEYS = ['MISTRAL_API_KEY', 'DEEPSEEK_API_KEY', 'ZAI_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY'];
function importProviderKeysFromLaunchd(env) {
  for (const key of PROVIDER_KEYS) {
    if (env[key]) continue;
    const r = spawnSync('launchctl', ['getenv', key], { encoding: 'utf8' });
    const value = (r.stdout ?? '').trim();
    if (r.status === 0 && value) env[key] = value;
  }
  return env;
}

async function start() {
  const port = Number(arg('--port', '3219'));
  const profile = arg('--profile', 'web');
  const existing = await readState();
  if (existing && (await alive(existing.pid))) {
    console.log(`mui-daemon: already running (pid ${existing.pid}) at ${existing.origin}`);
    console.log(`mui-daemon: url ${existing.origin}/?token=${existing.token}`);
    return;
  }
  const dash = process.argv.indexOf('--');
  const extra = dash >= 0 ? process.argv.slice(dash + 1) : [];
  const bin = process.env.DSH_BIN ?? 'dsh';
  const args = ['--profile', profile, '--no-open', '--port', String(port), ...extra];

  const logFd = await open(LOG, 'w');
  const child = spawn(bin, args, {
    detached: true,
    stdio: ['ignore', logFd.fd, logFd.fd],
    cwd: process.env.MUI_CWD ?? process.cwd(),
    env: importProviderKeysFromLaunchd({ ...process.env }),
  });
  child.unref();
  logFd.close();

  // wait for the tokenized URL in the log
  const deadline = Date.now() + 60_000;
  let token;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const text = await readFile(LOG, 'utf8');
      const m = text.match(/dsh web: (https?:\/\/\S*?token=([!-~]+))/);
      if (m) {
        token = m[2];
        break;
      }
      if (/startup failed|fatal load failure/.test(text)) {
        console.error('mui-daemon: dsh failed to boot:');
        console.error(text.split('\n').filter((l) => l.trim()).slice(0, 12).join('\n'));
        process.exit(1);
      }
    } catch {
      /* log not written yet */
    }
  }
  if (!token) {
    console.error('mui-daemon: boot timed out; see ' + LOG);
    process.exit(1);
  }
  const state = {
    pid: child.pid,
    port,
    profile,
    origin: `http://127.0.0.1:${port}`,
    token,
    cwd: process.env.MUI_CWD ?? process.cwd(),
    startedAt: new Date().toISOString(),
    logFile: LOG,
    extraArgs: extra,
  };
  await writeState(state);
  console.log(`mui-daemon: started (pid ${child.pid}, profile ${profile}, port ${port})`);
  console.log(`mui-daemon: url    ${state.origin}/?token=${token}`);
  console.log(`mui-daemon: attach a terminal face with: mui-view`);
  console.log(`mui-daemon: expose with:               mui-forward cloudflared|tailscale`);
}

async function stop() {
  const state = await readState();
  if (!state || !(await alive(state.pid))) {
    console.log('mui-daemon: not running');
    await rm(STATE, { force: true });
    return;
  }
  process.kill(state.pid, 'SIGTERM');
  for (let i = 0; i < 50 && (await alive(state.pid)); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (await alive(state.pid)) {
    process.kill(state.pid, 'SIGKILL');
    console.log('mui-daemon: force-killed');
  } else {
    console.log('mui-daemon: stopped');
  }
  await rm(STATE, { force: true });
}

async function status() {
  const state = await readState();
  if (!state) {
    console.log('mui-daemon: not initialized (start with: mui-daemon start)');
    return;
  }
  const up = await alive(state.pid);
  console.log(`mui-daemon: ${up ? 'running' : 'dead'} (pid ${state.pid}, profile ${state.profile}, port ${state.port})`);
  if (up) console.log(`mui-daemon: url ${state.origin}/?token=${state.token}`);
  console.log(`mui-daemon: log ${state.logFile}`);
}

async function url() {
  const state = await readState();
  if (!state || !(await alive(state.pid))) {
    console.error('mui-daemon: not running');
    process.exit(1);
  }
  console.log(`${state.origin}/?token=${state.token}`);
}

async function tailLog() {
  const state = await readState();
  const file = state?.logFile ?? LOG;
  if (!existsSync(file)) {
    console.log('(no log yet)');
    return;
  }
  const s = await stat(file);
  const len = Math.min(s.size, 4000);
  const buf = Buffer.alloc(len);
  const fh = await open(file, 'r');
  await fh.read(buf, 0, len, s.size - len);
  await fh.close();
  process.stdout.write(buf.toString('utf8'));
}

const runners = { start, stop, status, url, log: tailLog };
if (!runners[command]) {
  console.error('usage: mui-daemon start|stop|status|url|log [--port N] [--profile name] [-- <dsh args>]');
  process.exit(1);
}
await runners[command]();
