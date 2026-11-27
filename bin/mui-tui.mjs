#!/usr/bin/env node
// mui-tui — a terminal FACE on the running MUI core.
// コア(daemon)はそのまま。このフェイスはRPCクライアントとして同じセッションに
// 接続するだけなので、Web/スマホは一切影響を受けない。
//
//   mui tui [sessionId]     実行中優先 → 最新のセッションに接続
//
// 入力:
//   (文章) + Enter   送信 (実行中なら自動でQueueに入る)
//   /steer (文章)    実行中のターンへの追加指示 (steer)
//   /stop           実行中のターンを中断
//   /resume          最新の会話を取り込み直す
//   /reload          履歴を最初から描き直す
//   /help /quit
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DshClient, summarizeEvent } from '../lib/dsh-api.mjs';

const ACCENT = '\x1b[38;2;77;107;254m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const BAR = () => `${ACCENT}┃${RESET}`;
const accent = (t) => `${ACCENT}${t}${RESET}`;
const dim = (t) => `${DIM}${t}${RESET}`;
const safeText = (v) => (typeof v === 'string' ? v.replace(/\x1b/g, ' ') : '');

const LOADER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  if (i >= 0) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  return eq ? eq.slice(name.length + 1) : undefined;
};

// ── core接続 ────────────────────────────────────────────────────────────────
const state = JSON.parse(await readFile(join(homedir(), '.dsh', 'mui-daemon.json'), 'utf8'));
const client = new DshClient({ origin: flag('--url') ?? state.origin, token: flag('--token') ?? state.token });

// ── session解決: 実行中優先 → 最新 ─────────────────────────────────────────
async function resolveSession() {
  const explicit = flag('--session');
  if (explicit) return explicit;
  const { items } = await client.listSessions();
  const live = items.filter((x) => !x.blank && (!state.cwd || x.cwd === state.cwd));
  const pool = live.length ? live : items.filter((x) => !x.blank);
  pool.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  const running = pool.find((x) => x.running);
  return (running ?? pool[0])?.sessionId;
}

const sessionId = await resolveSession();
if (!sessionId) {
  console.error('mui-tui: 接続できるセッションがありません (mui new で作成)');
  process.exit(1);
}

// ── rendering ───────────────────────────────────────────────────────────────
let running = false;
let runningSince = 0;
let input = '';
let frame = 0;
let lastSeq = -1;
let promptDrawn = false;

function statusPrefix() {
  if (!running) return '';
  const secs = Math.floor((Date.now() - runningSince) / 1000);
  const glyph = accent(LOADER_FRAMES[frame % LOADER_FRAMES.length]);
  return `${glyph} `;
}

function reprintPrompt() {
  process.stdout.write(`\r\x1b[K  ${statusPrefix()}${BAR()} ${input}`);
  promptDrawn = true;
}

function clearPromptLine() {
  if (promptDrawn) process.stdout.write('\r\x1b[K');
  promptDrawn = false;
}

function printUser(text) {
  clearPromptLine();
  process.stdout.write(`  ${BAR()} ${safeText(text).replace(/\n/g, `\n  ${BAR()} `)}\n`);
}

function printAssistant(text) {
  const t = safeText(text).trim();
  if (!t) return;
  clearPromptLine();
  process.stdout.write(`${t}\n`);
}

function printNote(label, text) {
  clearPromptLine();
  process.stdout.write(`${accent('✓')} ${dim(`${label}: ${safeText(text)}`)}\n`);
}

function printErr(text) {
  clearPromptLine();
  process.stdout.write(`${accent('✗')} ${dim(safeText(text))}\n`);
}

function renderEvent(ev) {
  const s = summarizeEvent(ev);
  switch (s.kind) {
    case 'user':
      if (s.text.startsWith('Current runtime context.')) return;
      if (s.text.startsWith('Time sampled while preparing')) return;
      if (s.text.startsWith('<system-reminder>')) return;
      return printUser(s.text);
    case 'assistant':
      return printAssistant(s.text);
    case 'model':
      return printNote('model', s.text);
    case 'title':
      return undefined; // ノイズなので非表示
    default:
      return undefined;
  }
}

// ── live loop ───────────────────────────────────────────────────────────────
function syncFrom(events) {
  let drew = false;
  for (const ev of events) {
    if (typeof ev.seq === 'number' && ev.seq <= lastSeq) continue;
    const before = promptDrawn;
    renderEvent(ev);
    drew = drew || before !== promptDrawn || true;
    if (typeof ev.seq === 'number') lastSeq = Math.max(lastSeq, ev.seq);
  }
  return drew;
}

async function pollEvents() {
  try {
    const page = await client.pageEvents(sessionId, { maxMessages: 40 });
    const events = page.records.map((rec) => rec.event ?? rec);
    const drew = syncFrom(events);
    if (drew) reprintPrompt();
  } catch {
    /* core busy — 次のtickでリトライ */
  }
}

async function pollState() {
  try {
    const st = await client.state(sessionId);
    const nowRunning = Boolean(st.running);
    if (nowRunning && !running) {
      running = true;
      runningSince = Date.now();
      clearPromptLine();
      process.stdout.write(dim('─'.repeat(Math.min(56, process.stdout.columns ?? 56))) + '\n');
      reprintPrompt();
    } else if (!nowRunning && running) {
      running = false;
      reprintPrompt();
    } else if (running) {
      frame++;
      reprintPrompt();
    }
  } catch {
    /* ignore */
  }
}

// ── input (raw line editor) ────────────────────────────────────────────────
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.setEncoding('utf8');

console.log(`${accent('mui-tui')} ${dim('· terminal face · コアはそのまま動き続けます')}`);
console.log(dim(`  ${sessionId}`));
await pollEvents();
printNote('attached', '(文章)=送信/Queue · /steer (文章)=実行中への指示 · /help');
reprintPrompt();

const stateTimer = setInterval(pollState, 900);
const eventTimer = setInterval(pollEvents, 450);

async function handleLine(raw) {
  const text = raw.trim();
  if (!text) return;
  if (text === '/quit' || text === '/q') {
    clearPromptLine();
    printNote('detached', 'コアはこのまま動き続けます (Webも無傷)');
    process.exit(0);
  }
  if (text === '/help') {
    printNote('help', '(文章)=送信/Queue · /steer (文章)=実行中への指示 · /stop=中断 · /resume=同期 · /reload=再描画 · /quit=離脱 (Ctrl+C×2でも離脱)');
    return;
  }
  if (text === '/stop') {
    await client.cancel(sessionId);
    return printNote('cancel', '中断を要求しました');
  }
  if (text === '/resume') {
    await pollEvents();
    return printNote('resumed', '最新の会話を取り込みました');
  }
  if (text === '/reload') {
    clearPromptLine();
    process.stdout.write('\x1b[2J\x1b[H');
    console.log(`${accent('mui-tui')} ${dim('· terminal face · コアはそのまま動き続けます')}`);
    console.log(dim(`  ${sessionId}`));
    lastSeq = -1;
    await pollEvents();
    return printNote('reloaded', '履歴を再描画しました');
  }
  if (text.startsWith('/steer ')) {
    const body = text.slice(7).trim();
    if (!body) return printErr('/steer に指示文が必要です');
    printUser(body);
    try {
      await client.prompt(sessionId, body, { mode: 'steer' });
      printNote('steer', '実行中のターンへ指示を送りました');
    } catch (e) {
      printErr(`steer: ${e.message}`);
    }
    return;
  }
  if (text.startsWith('/')) {
    return printErr(`不明なコマンド "${text.split(/\s+/)[0]}" — /help`);
  }
  // 通常送信 (queueモード: 実行中なら自動的にQueueに入る)
  printUser(text);
  try {
    await client.prompt(sessionId, text, { mode: 'queue' });
  } catch (e) {
    printErr(`send: ${e.message}`);
  }
}

let lastCtrlC = 0;
process.stdin.on('data', async (chunk) => {
  const s = chunk.toString('utf8');
  for (const ch of s) {
    if (ch === '\r') {
      const line = input;
      input = '';
      clearPromptLine();
      process.stdout.write('\n');
      await handleLine(line);
      reprintPrompt();
      continue;
    }
    if (ch === '\x7f') {
      input = input.slice(0, -1);
      reprintPrompt();
      continue;
    }
    if (ch === '\x03') {
      const now = Date.now();
      if (now - lastCtrlC < 1500) {
        clearPromptLine();
        printNote('detached', 'コアはこのまま動き続けます');
        process.exit(0);
      }
      lastCtrlC = now;
      input = '';
      await client.cancel(sessionId);
      printNote('cancel', '中断を要求しました (もう一度Ctrl+Cで離脱)');
      reprintPrompt();
      continue;
    }
    if (ch === '\x15') {
      input = '';
      reprintPrompt();
      continue;
    }
    if (ch < ' ') continue;
    input += ch;
    reprintPrompt();
  }
});

process.on('exit', () => {
  clearInterval(stateTimer);
  clearInterval(eventTimer);
  try { process.stdin.setRawMode(false); } catch { /* already exited */ }
});
