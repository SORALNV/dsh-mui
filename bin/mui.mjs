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

const dir = join(import.meta.dirname, '..');
const daemon = join(dir, 'bin', 'mui-daemon.mjs');
const view = join(dir, 'bin', 'mui-view.mjs');
const forward = join(dir, 'bin', 'mui-forward.mjs');
const STATE = join(homedir(), '.dsh', 'mui-daemon.json');

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

if (command === '--profile' || command === '-p') {
  const r = spawnSync('dsh', ['--profile', argv[1] ?? 'mui'], { stdio: 'inherit' });
  process.exit(r.status ?? 0);
}

switch (command) {
  case undefined: {
    if (!(await daemonRunning())) {
      console.log('mui: starting daemon…');
      const r = spawnSync(process.execPath, [daemon, 'start', '--port', process.env.MUI_PORT ?? '3080'], {
        stdio: 'inherit',
      });
      if (r.status !== 0) process.exit(r.status ?? 1);
    }
    const child = spawn(process.execPath, [view, ...argv.slice(1)], { stdio: 'inherit' });
    child.on('exit', (code) => process.exit(code ?? 0));
    break;
  }
  case 'tui': {
    // フルTUI (dsh-TUI + Web を1プロセスで) に席を譲る:
    // daemon を止め → TUI をフォアグラウンドで起動 → トークンを捕捉して
    // mui url / mui-view / 8444 経由がそのまま使えるようにする。
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
    if (!(await daemonRunning())) {
      const r = spawnSync(process.execPath, [daemon, 'start', '--port', process.env.MUI_PORT ?? '3080'], {
        stdio: 'inherit',
      });
      if (r.status !== 0) process.exit(r.status ?? 1);
    }
    run(view, ['--new', ...argv.slice(1)]);
    break;
  }
  case 'attach':
    run(view, ['--session', argv[1], ...argv.slice(2)]);
    break;
  case 'resume': {
    if (!(await daemonRunning())) {
      const r = spawnSync(process.execPath, [daemon, 'start', '--port', process.env.MUI_PORT ?? '3080'], {
        stdio: 'inherit',
      });
      if (r.status !== 0) process.exit(r.status ?? 1);
    }
    let target = argv[1];
    if (!target) {
      // 最後に触っていたセッションへ (tmux attach 相当)。
      // 候補は daemon と同じワークスペースのセッションに限定し、attach 試行で
      // 他プロセスのロック衝突 (session/conflict) なら次の候補へ落ちる。
      const state = JSON.parse(await readFile(STATE, 'utf8'));
      let daemonCwd = state.cwd;
      if (!daemonCwd) {
        const out = spawnSync('lsof', ['-a', '-p', String(state.pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8' });
        daemonCwd = (out.stdout ?? '').split('\n').find((l) => l.startsWith('n/'))?.slice(1);
      }
      const client = new DshClient({ origin: state.origin, token: state.token });
      const { items } = await client.listSessions();
      const candidates = items
        .filter((x) => !x.blank && (!daemonCwd || x.cwd === daemonCwd))
        .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
      target = undefined;
      for (const cand of candidates.slice(0, 5)) {
        // ロックを握らない (prompt時点でhostが解決する)。参照可能かの確認のみ。
        try {
          await client.call('session/page', { address: { kind: 'session', sessionId: cand.sessionId }, maxMessages: 1 });
          target = cand.sessionId;
          const when = cand.updatedAt ? new Date(cand.updatedAt).toLocaleString('ja-JP') : '';
          console.log(`mui: resuming ${cand.sessionId} ${when}`);
          break;
        } catch (e) {
          continue; // 読めなければ次の候補
        }
      }
      if (!target) {
        console.error('mui: 再開できるセッションがありません (mui new で作成してください)');
        process.exit(1);
      }
    }
    run(view, ['--session', target]);
    break;
  }
  case 'list':
    run(view, ['list']);
    break;
  case 'url':
  case 'start':
  case 'status':
  case 'log':
    run(daemon, [command]);
    break;
  case 'stop':
    run(daemon, ['stop']);
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

  mui                       コア(daemon)が無ければ起動し、mui-viewで接続する。
                            実行したディレクトリがセッションのワークスペースになる。
  mui new ["最初の指示"]     新しいセッションを作成して接続する。
                            指示を付けると初回プロンプトとして送信する。
  mui resume [id]           最後に触っていたセッションを再開する (tmux attach相当)。
                            自分のコアが所有するセッションだけを候補にするため、
                            他プロセスのセッションと衝突しない。id指定で任意へ。
  mui attach <id>           セッションをID直指定で接続する。
  mui list                  セッション一覧を表示する (●=実行中)。
  mui url                   ブラウザ用のトークン付きURLを表示する。
                            トークンはプロセス毎に変わるので、繋がらない時は再取得。
  mui start                 コアの起動だけ行う (接続しない)。
  mui status                コアの稼働状態 (pid / port / トークン) を表示する。
  mui stop                  コアを正常終了する (SIGTERM)。
  mui kill                  コアを強制終了する (SIGKILL)。
                            ポートの残骸リスナーも掃除する。復帰は mui でOK。
  mui log                   コアのログ末尾を表示する (tail -f で追跡)。
  mui forward <kind>        コアを外部公開する: tailscale | cloudflared | off | status
  mui tui                   フルTUI (dsh-TUI) を前面で起動する。
                            TUI自体がコアの座に着く (Web面も同プロセスで提供)。
                            普段のTUIと同じUI/UXで作業したい時に使う。
                            TUIを閉じるとコアも終了する (セッションは保存済み)。
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
