#!/usr/bin/env node
// mui-forward — expose a running MUI daemon through a public/tailnet URL.
//
//   mui-forward cloudflared [--port N]   # Cloudflare quick tunnel (trycloudflare.com)
//   mui-forward tailscale [--port N]     # tailscale serve (tailnet-only HTTPS)
//   mui-forward off                      # tear tunnels down
//   mui-forward status
//
// Flow: start the tunnel → learn its URL → restart mui-daemon with
// --public-url/--trusted-host so the Host/Origin fence admits the browser.

import { spawn, spawnSync } from 'node:child_process';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOME = join(homedir(), '.dsh');
const STATE = join(HOME, 'mui-daemon.json');
const CF_LOG = join(HOME, 'mui-forward-cloudflared.log');

const argv = process.argv.slice(2);
const command = argv[0] ?? 'status';
const arg = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : fallback;
};
const port = () => Number(arg('--port', '3219'));

const daemonScript = join(import.meta.dirname, 'mui-daemon.mjs');

async function readState() {
  try {
    return JSON.parse(await readFile(STATE, 'utf8'));
  } catch {
    return undefined;
  }
}

function restartDaemonWith(extraArgs, port_) {
  spawnSync(process.execPath, [daemonScript, 'stop'], { stdio: 'inherit' });
  const r = spawnSync(process.execPath, [daemonScript, 'start', '--port', String(port_), '--', ...extraArgs], {
    stdio: 'inherit',
  });
  return r.status === 0;
}

async function waitForLine(file, regex, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const text = await readFile(file, 'utf8');
      const m = text.match(regex);
      if (m) return m[0];
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return undefined;
}

async function forwardCloudflared() {
  const p = port();
  const logFd = await import('node:fs/promises').then((fs) => fs.open(CF_LOG, 'w'));
  // --config /dev/null: ignore ~/.cloudflared/config.yml (named-tunnel ingress
  // would otherwise catch-all-404 the quick-tunnel hostname).
  const child = spawn('cloudflared', ['tunnel', '--config', '/dev/null', '--url', `http://127.0.0.1:${p}`], {
    detached: true,
    stdio: ['ignore', logFd.fd, logFd.fd],
  });
  child.unref();
  await logFd.close();
  await writeFile(join(HOME, 'mui-forward.pid'), String(child.pid) + '\n');
  console.log(`mui-forward: cloudflared starting (pid ${child.pid}) …`);
  const url = await waitForLine(CF_LOG, /https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
  if (!url) {
    console.error('mui-forward: tunnel URL not found in time; see ' + CF_LOG);
    process.exit(1);
  }
  const host = new URL(url).host;
  console.log(`mui-forward: tunnel ${url}`);
  const ok = restartDaemonWith(['--public-url', url, '--trusted-host', host], p);
  if (!ok) process.exit(1);
  const state = await readState();
  console.log(`mui-forward: public URL: ${url}/?token=${state?.token ?? '<see mui-daemon url>'}`);
  console.log('mui-forward: tear down with `mui-forward off` (restarts the daemon local-only)');
}

async function forwardTailscale() {
  const p = port();
  const st = spawnSync('tailscale', ['status', '--json'], { encoding: 'utf8' });
  if (st.status !== 0) {
    console.error('mui-forward: tailscale is not running/signed in.');
    process.exit(1);
  }
  const info = JSON.parse(st.stdout);
  const dns = (info.Self?.DNSName ?? '').replace(/\.$/, '');
  if (!dns) {
    console.error('mui-forward: no tailnet DNS name for this machine.');
    process.exit(1);
  }
  const serve = spawnSync('tailscale', ['serve', '--bg', String(p)], { encoding: 'utf8' });
  if (serve.status !== 0) {
    console.error('mui-forward: tailscale serve failed:\n' + (serve.stderr || serve.stdout));
    process.exit(1);
  }
  const url = `https://${dns}`;
  console.log(`mui-forward: tailscale serve → ${url} (tailnet only)`);
  const ok = restartDaemonWith(['--public-url', url, '--trusted-host', dns], p);
  if (!ok) process.exit(1);
  const state = await readState();
  console.log(`mui-forward: tailnet URL: ${url}/?token=${state?.token ?? '<see mui-daemon url>'}`);
}

async function off() {
  spawnSync('tailscale', ['serve', '--reset'], { stdio: 'inherit' });
  try {
    const pid = Number((await readFile(join(HOME, 'mui-forward.pid'), 'utf8')).trim());
    if (pid) {
      process.kill(pid, 'SIGTERM');
      console.log('mui-forward: cloudflared stopped');
    }
  } catch {
    console.log('mui-forward: no cloudflared pid recorded');
  }
  await rm(join(HOME, 'mui-forward.pid'), { force: true });
  console.log('mui-forward: note — the daemon still advertises the old public URL; restart it to go local-only:');
  console.log('  mui-daemon stop && mui-daemon start');
}

async function status() {
  const state = await readState();
  console.log('mui-daemon:', state ? `${state.origin} (pid ${state.pid})` : 'not running');
  try {
    const cf = await readFile(CF_LOG, 'utf8');
    const m = cf.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    console.log('cloudflared:', m ? m[0] : 'running (URL pending)');
  } catch {
    console.log('cloudflared: not started');
  }
}

const runners = { cloudflared: forwardCloudflared, tailscale: forwardTailscale, off, status };
if (!runners[command]) {
  console.error('usage: mui-forward cloudflared|tailscale|off|status [--port N]');
  process.exit(1);
}
await runners[command]();
