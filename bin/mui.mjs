#!/usr/bin/env node
// mui — unified launcher for the MUI stack.
//
//   mui                 # daemon が無ければ起動して mui-view で attach
//   mui list            # セッション一覧
//   mui url             # ブラウザ用トークン付きURL
//   mui stop            # daemon 停止
//   mui forward tailscale|cloudflared|off|status
//   mui --profile <p>   # 前景モード (dsh --profile <p>) のエイリアス

import { spawn, spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const dir = join(import.meta.dirname, '..');
const daemon = join(dir, 'bin', 'mui-daemon.mjs');
const view = join(dir, 'bin', 'mui-view.mjs');
const forward = join(dir, 'bin', 'mui-forward.mjs');
const STATE = join(homedir(), '.dsh', 'mui-daemon.json');

const argv = process.argv.slice(2);
const command = argv[0];

async function daemonRunning() {
  try {
    const state = JSON.parse(await readFile(STATE, 'utf8'));
    process.kill(state.pid, 0);
    return true;
  } catch {
    return false;
  }
}

if (command === '--profile' || command === '-p') {
  const profile = argv[1] ?? 'mui';
  const r = spawnSync('dsh', ['--profile', profile], { stdio: 'inherit' });
  process.exit(r.status ?? 0);
}

switch (command) {
  case undefined: {
    if (!(await daemonRunning())) {
      console.log('mui: starting daemon…');
      const r = spawnSync(process.execPath, [daemon, 'start', '--port', process.env.MUI_PORT ?? '3219'], {
        stdio: 'inherit',
      });
      if (r.status !== 0) process.exit(r.status ?? 1);
    }
    const child = spawn(process.execPath, [view, ...argv.slice(1)], { stdio: 'inherit' });
    child.on('exit', (code) => process.exit(code ?? 0));
    break;
  }
  case 'list':
  case 'url':
  case 'stop': {
    const map = { list: view, url: daemon, stop: daemon };
    const r = spawnSync(process.execPath, [map[command], command === 'list' ? 'list' : command], { stdio: 'inherit' });
    process.exit(r.status ?? 0);
    break;
  }
  case 'forward': {
    const r = spawnSync(process.execPath, [forward, ...argv.slice(1)], { stdio: 'inherit' });
    process.exit(r.status ?? 0);
    break;
  }
  case 'help':
  case '--help':
  case '-h':
    console.log('mui                 daemon を起動（無ければ）して mui-view で attach');
    console.log('mui list            セッション一覧');
    console.log('mui url             ブラウザ用URL');
    console.log('mui stop            daemon 停止');
    console.log('mui forward <kind>  tailscale | cloudflared | off | status');
    console.log('mui --profile <p>   前景モード (dsh --profile <p>)');
    break;
  default:
    console.error(`mui: unknown command "${command}" (see: mui help)`);
    process.exit(1);
}
