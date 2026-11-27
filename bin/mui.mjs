#!/usr/bin/env node
// mui — unified launcher for the MUI stack. Everything goes through here.
//
//   mui                       daemon が無ければ起動して mui-view で attach
//   mui new ["prompt"]        新規セッションを作って attach
//   mui attach <id>           セッションを直指定で attach
//   mui list                  セッション一覧
//   mui url                   ブラウザ用トークン付きURL
//   mui start                 daemon 起動のみ
//   mui status                daemon の状態
//   mui stop                  daemon を正常停止 (SIGTERM)
//   mui kill                  daemon を強制停止 (SIGKILL, ポートも解放)
//   mui log                   daemon ログの末尾
//   mui forward tailscale|cloudflared|off|status
//   mui --profile <p>         前景モード (dsh --profile <p>)
//   mui help

import { spawn, spawnSync } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DshClient } from '../lib/dsh-api.mjs';
import { pickInteractive } from './mui-pick.mjs';

const dir = join(import.meta.dirname, '..');
const daemon = join(dir, 'bin', 'mui-daemon.mjs');
const view = join(dir, 'bin', 'mui-view.mjs');
const forward = join(dir, 'bin', 'mui-forward.mjs');
const STATE = join(homedir(), '.dsh', 'mui-daemon.json');

// フルスクリーン・セッションピッカーを起動して選択結果を返す
// 戻り値: sessionId | 'new' | null (quit)
async function runPicker() {
  const state = JSON.parse(await readFile(STATE, 'utf8'));
  let daemonCwd = state.cwd;
  if (!daemonCwd && state.pid) {
    const out = spawnSync('lsof', ['-a', '-p', String(state.pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8' });
    daemonCwd = (out.stdout ?? '').split('\n').find((l) => l.startsWith('n/'))?.slice(1);
  }
  const client = new DshClient({ origin: state.origin, token: state.token });
  return pickInteractive({ client, daemonCwd });
}

// ワークスペース(daemonのcwd)の最新セッションを1つ返す
async function latestWorkspaceSession() {
  const state = JSON.parse(await readFile(STATE, 'utf8'));
  let daemonCwd = state.cwd;
  if (!daemonCwd && state.pid) {
    const out = spawnSync('lsof', ['-a', '-p', String(state.pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8' });
    daemonCwd = (out.stdout ?? '').split('\n').find((l) => l.startsWith('n/'))?.slice(1);
  }
  const client = new DshClient({ origin: state.origin, token: state.token });
  const { items } = await client.listSessions();
  const candidates = items
    .filter((x) => !x.blank && (!daemonCwd || x.cwd === daemonCwd))
    .sort((a, b) => new Date(b.updatedAt ?? 0) - new Date(a.updatedAt ?? 0));
  // 参照可能かの確認だけ行い、ロックは握らない (prompt時点でhostが解決する)
  for (const cand of candidates) {
    try {
      await client.call('session/page', { address: { kind: 'session', sessionId: cand.sessionId }, maxMessages: 1 });
      return cand.sessionId;
    } catch {
      continue;
    }
  }
  return undefined;
}

const argv = process.argv.slice(2);
const command = argv[0];

const run = (script, args) => {
  const r = spawnSync(process.execPath, [script, ...args], { stdio: 'inherit' });
  process.exit(r.status ?? 0);
};

async function daemonRunning() {
  try {
    const state = JSON.parse(await readFile(STATE, 'utf8'));
    process.kill(state.pid, 0);
    return state;
  } catch {
    return undefined;
  }
}

async function killDaemon() {
  const state = await daemonRunning();
  if (state) {
    process.kill(state.pid, 'SIGKILL');
    console.log(`mui: killed (pid ${state.pid})`);
  } else {
    console.log('mui: daemon not running');
  }
  // ポートに残骸がいれば掃除 (pid 記録が古い場合の取りこぼし)
  const port = state?.port ?? 3219;
  const stray = spawnSync('lsof', ['-tiTCP', `:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' });
  for (const pid of (stray.stdout ?? '').split('\n').map((s) => s.trim()).filter(Boolean)) {
    try {
      process.kill(Number(pid), 'SIGKILL');
      console.log(`mui: killed stray listener on :${port} (pid ${pid})`);
    } catch {
      /* already gone */
    }
  }
  await rm(STATE, { force: true });
}

// コアを(必要なら)起動し、結果を一目で分かる文にして返す
async function ensureDaemon() {
  if (await daemonRunning()) {
    const s = JSON.parse(await readFile(STATE, 'utf8'));
    console.log(`mui: コアは既に起動済みです → ${s?.origin ?? ''}`);
    return;
  }
  console.log('mui: コアを起動中…');
  const r = spawnSync(process.execPath, [daemon, 'start', '--port', process.env.MUI_PORT ?? '3080'], {
    stdio: 'inherit',
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
  const s = JSON.parse(await readFile(STATE, 'utf8'));
  console.log(`mui: ✓ コアを起動しました → ${s?.origin ?? ''}`);
}

if (command === '--profile' || command === '-p') {
  const r = spawnSync('dsh', ['--profile', argv[1] ?? 'mui'], { stdio: 'inherit' });
  process.exit(r.status ?? 0);
}

switch (command) {
  case undefined: {
    // mui はコアの起動だけ (フェイスは mui resume / mui view / ブラウザで別途)
    await ensureDaemon();
    break;
  }
  case 'tui': {
    // mui tui = コアに接続する「端末フェイス」。コア(daemon)はそのまま:
    // Web/スマホは一切影響を受けず、トークンも何も変わらない。
    await ensureDaemon();
    const extra = argv.slice(1).filter((a) => a && !a.startsWith('--cwd'));
    const child = spawn(process.execPath, [join(dir, 'bin', 'mui-tui.mjs'), ...extra], { stdio: 'inherit' });
    child.on('exit', (code) => process.exit(code ?? 0));
    break;
  }
  case 'tui-host': {
    // 旧仕様: フルdsh-TUIがコアの座に着く (Web面も同プロセスで提供)。
    // 通常は使わない: コアが入れ替わるためブラウザは再接続が必要。
    await killDaemon();
    const port = process.env.MUI_PORT ?? '3080';
    const logFile = join(homedir(), '.dsh', 'mui-tui.log');
    const watcher = spawn(process.execPath, [join(dir, 'bin', 'mui-token-watch.mjs'), '--log', logFile, '--port', port, '--cwd', process.cwd()], {
      detached: true,
      stdio: 'ignore',
    });
    watcher.unref();
    const r = spawnSync('python3', [join(dir, 'bin', 'mui-pty.py'), 'dsh', '--profile', 'mui', '--no-open', '--port', port], {
      stdio: 'inherit',
      env: { ...process.env, MUI_PTY_LOG: logFile, MUI_PTY_FIFO: `/tmp/mui-tui-${Date.now()}.in` },
    });
    await rm(STATE, { force: true }); // TUI終了 → トークン無効
    process.exit(r.status ?? 0);
    break;
  }
  case 'new': {
    await ensureDaemon();
    run(view, ['--new', '--cwd', process.cwd(), ...argv.slice(1)]);
    break;
  }
  case 'attach':
    run(view, ['--session', argv[1], ...argv.slice(2)]);
    break;
  case 'resume': {
    await ensureDaemon();
    let target = argv[1];
    if (!target && process.stdin.isTTY) {
      // フルスクリーン・セッションピッカー (↑↓ / 検索 / フィルタ / アーカイブ)
      const picked = await runPicker();
      if (picked === null) process.exit(0);
      target = picked === 'new' ? undefined : picked;
    } else if (!target) {
      // TTY無し (パイプ等): 最後に触っていたセッションへ自動resume
      target = await latestWorkspaceSession();
      if (!target) {
        console.error('mui: 再開できるセッションがありません (mui new で作成してください)');
        process.exit(1);
      }
    }
    run(view, target ? ['--session', target] : ['--new']);
    break;
  }
  case 'list':
    run(view, ['list']);
    break;
  case 'url': {
    const s = JSON.parse(await readFile(STATE, 'utf8'));
    const local = `${s.origin}/?token=${s.token}`;
    console.log(`local:    ${local}`);
    const host = s.tailscaleHost ?? 'macstudio.tailcf365a.ts.net';
    console.log(`スマホ等:  https://${host}/?token=${s.token}`);
    // ローカル(非SSH)なら既定ブラウザも開く
    if (!process.env.SSH_CONNECTION && !process.env.SSH_TTY && !argv.includes('--no-open')) {
      try { spawnSync('open', [local], { stdio: 'ignore' }); } catch { /* headless環境では無視 */ }
    }
    break;
  }
  case 'mcp':
    await import('./mui-mcp.mjs');
    break;
  case 'log':
    run(daemon, ['log']);
    break;
  case 'kill':
    await killDaemon();
    break;
  case 'takeover':
    run('/bin/bash', [join(dir, 'bin', 'mui-takeover')]);
    break;
  case 'forward':
    run(forward, argv.slice(1));
    break;
  case 'help':
  case '--help':
  case '-h':
    console.log(`mui — Multi UI for DeepSeek Harness
1つのセッションコア(daemon)に、ターミナル・ブラウザ・スマホが同時に接続します。
どこからの発言も全フェイスにリアルタイム表示されます。

■ 基本の流れ

  1) mui                    コアを起動(無ければ)してターミナルから接続
  2) mui url                表示されるURLをブラウザで開く → 同じセッション
  3) mui forward tailscale  外部(Tailnet)に公開 → スマホからも同じセッション

■ コマンド


  mui new ["最初の指示"]     新しいセッションを作成して接続する。
                            指示を付けると初回プロンプトとして送信する。
  mui resume [id]           セッション一覧から選んで再開する (↑↓/検索/フィルタ、
                            Enter resume / Esc 新規 / ^a archive)。id 指定なら直行。
  mui attach <id>           セッションをID直指定で接続する。
  mui list                  セッション一覧を表示する (●=実行中)。
  mui url                   ブラウザ用のトークン付きURLを表示する。
                            トークンはプロセス毎に変わるので、繋がらない時は再取得。
  mui kill                  コアを強制終了する (SIGKILL)。
                            ポートの残骸リスナーも掃除する。復帰は mui でOK。
  mui log                   コアのログ末尾を表示する (tail -f で追跡)。
  mui mcp                   OpenMausBot等から接続するローカルstdio MCP。
                            MUI_MCP_SESSIONS に許可するセッションIDを指定。
  mui forward <kind>        コアを外部公開する: tailscale | cloudflared | off | status
  mui tui [id]              端末フェイスを開く (コアはそのまま)。
                            Web/スマホは無傷・URLも不変。実行中優先で接続。
                            実行中に入力すればQueue、/steer (文章)で割り込み指示。
  mui url                   ローカルURLとスマホ用URLを表示 (ローカルなら開く)。
  mui takeover              単独の dsh web を廃止し、コアを3080ポートで常駐させる
                            移行コマンド (一度実行すれば以後は不要)。
  mui --profile <p>         従来型の前景モード (dsh --profile <p>)。

■ mui-view 内のコマンド (接続後に入力できる)

  (文章) + Enter            プロンプトを送信する (キューに入る)
  /resume                   画面を最新の会話に同期し直す
  /reload                   履歴を最初から描き直す
  /stop                     実行中のターンを中断する
  /quit                     切り離す (セッションとターンは生き続ける)
  /help                     コマンド一覧を表示する

■ 覚えておくと良いこと

  - /quit や SSH 切断でもターンは止まらない (コアが生かし続ける)。
    後で mui resume すれば続きが見える。
  - 「セッションは使用中」エラーが出たら、そのセッションの所有ホストと
    アクセス元のURL (ポート) が違う。mui resume なら自動で避ける。
  - テスト等で作ったセッションは workspace/archiveSession で一覧から隠せる。`);
    break;
  default:
    console.error(`mui: unknown command "${command}" (see: mui help)`);
    process.exit(1);
}
