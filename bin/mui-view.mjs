#!/usr/bin/env node
// mui-view — a minimal terminal face for a running MUI daemon.
//
//   mui-view list
//   mui-view [--session <id>] [--url <origin>] [--token <token>]
//   mui-view --new ["initial prompt"]
//
// Visual language:
//   accent  = RGB(77,107,254)
//   dim     = ANSI dim
//   user    = "  ┃ text" with blank-line separation
//   input   = same "  ┃ " prompt
//   notify  = "✗ error: …" / "✓ label: …"
//   busy    = "⠋ Thinking (Ns)" braille loader, padding 2

import { createInterface } from 'node:readline';
import { stripVTControlCharacters } from 'node:util';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DshClient, summarizeEvent } from '../lib/dsh-api.mjs';

// ── theme ────────────────────────────────────────────────────────────────

const colored = process.env.NO_COLOR === undefined && process.env.TERM !== 'dumb';
const accent = (text) => (colored ? `\x1b[38;2;77;107;254m${text}\x1b[0m` : String(text));
const dim = (text) => (colored ? `\x1b[2m${text}\x1b[0m` : String(text));
const safeText = (value) => stripVTControlCharacters(String(value)).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
const notification = (label, text) => {
  const icon = /error/i.test(label) ? '✗' : '✓';
  return `${accent(icon)} ${dim(safeText(label).toLowerCase() + ':')} ${safeText(text)}`;
};
const BAR = () => accent('┃');
const LOADER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

// ── target resolution ───────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  if (i >= 0) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`${name}=`)); // --session=<id> 形式
  return eq ? eq.slice(name.length + 1) : undefined;
};
const has = (name) => argv.includes(name);

async function resolveTarget() {
  if (flag('--url') && flag('--token')) return { origin: flag('--url'), token: flag('--token') };
  if (process.env.MUI_URL && process.env.MUI_TOKEN) {
    return { origin: process.env.MUI_URL, token: process.env.MUI_TOKEN };
  }
  try {
    const state = JSON.parse(await readFile(join(homedir(), '.dsh', 'mui-daemon.json'), 'utf8'));
    return { origin: state.origin, token: state.token };
  } catch {
    console.error(notification('error', 'no daemon state. Start one with `mui-daemon start`, or pass --url/--token.'));
    process.exit(1);
  }
}

// ── rendering (block style) ─────────────────────────────────────────────────

let spinnerLine = false; // is the Thinking line currently at the bottom?
const clearSpinner = () => {
  if (spinnerLine) process.stdout.write('\r\x1b[K');
  spinnerLine = false;
};

function printUser(text) {
  clearSpinner();
  const lines = safeText(text).split('\n');
  console.log('');
  for (const line of lines) console.log(line.trim() ? `  ${BAR()} ${line}` : `  ${BAR()}`);
  console.log('');
}

function printAssistant(text) {
  if (!safeText(text).trim()) return;
  clearSpinner();
  console.log(safeText(text));
  console.log('');
}

function printNotification(label, text) {
  clearSpinner();
  console.log(notification(label, text));
  console.log('');
}

function printDim(text) {
  clearSpinner();
  console.log(dim(`· ${text}`));
}

function renderEvent(ev) {
  const s = summarizeEvent(ev);
  switch (s.kind) {
    case 'user':
      if (s.text.startsWith('Current runtime context.')) return printDim('runtime context updated');
      if (s.text.startsWith('Time sampled while preparing')) return printDim('time sample');
      return printUser(s.text);
    case 'assistant':
      return printAssistant(s.text);
    case 'model':
      return printNotification('model', s.text);
    case 'title':
      return printNotification('title', s.text);
    default:
      return undefined;
  }
}

async function pickSession(client) {
  const { items } = await client.listSessions();
  const live = items.filter((x) => !x.blank);
  const rows = (live.length ? live : items).slice(0, 12);
  rows.forEach((x, i) => {
    console.log(
      dim(`${String(i + 1).padStart(2)}) `) +
        safeText(x.sessionId ?? '').slice(0, 18) +
        dim(`${x.running ? ' · running' : x.blank ? ' · blank' : ''} ${x.cwd ?? ''}`),
    );
  });
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => rl.question(`  ${BAR()} `, resolve));
  rl.close();
  const pick = rows[Number(answer) - 1];
  if (!pick) process.exit(1);
  return pick.sessionId;
}

// ── main ────────────────────────────────────────────────────────────────────

const { origin, token } = await resolveTarget();
const client = new DshClient({ origin, token });

let sessionId = flag('--session');
if (has('list') || argv[0] === 'list') {
  const { items } = await client.listSessions();
  for (const x of items.slice(0, 20)) {
    console.log(
      `${x.running ? accent('●') : dim('○')} ${safeText(x.sessionId ?? '').padEnd(40)} ` +
        dim(`${x.blank ? 'blank  ' : ''}${x.cwd ?? ''}`),
    );
  }
  process.exit(0);
}
if (has('--new')) {
  const createArgs = flag('--cwd') ? { cwd: flag('--cwd') } : {};
  const created = await client.call('session/create', createArgs);
  sessionId = created.sessionId;
  const initial = argv[argv.indexOf('--new') + 1];
  if (initial && !initial.startsWith('-')) await client.prompt(sessionId, initial);
} else if (!sessionId) {
  sessionId = await pickSession(client);
}

// banner (startup-banner style, no whale)
console.log('');
console.log(`${accent('mui-view')} ${dim('· a terminal face attached to the MUI daemon')} `);
console.log(dim(`  ${sessionId}${''}`));
console.log('');

// render boot context: 直近のやり取りだけにして情報過多を防ぐ (/reload で全文)
let lastSeq = -1;
{
  const page = await client.pageEvents(sessionId, { maxMessages: 80 });
  const events = page.records.map((rec) => rec.event ?? rec);
  const talkKinds = new Set(['user', 'assistant']);
  const talkEvents = events.filter((ev) => talkKinds.has(summarizeEvent(ev).kind));
  const keep = new Set(talkEvents.slice(-6)); // 直近6件のやり取りだけ表示
  let skipped = 0;
  let started = false;
  for (const ev of events) {
    const s = summarizeEvent(ev);
    const isTalk = talkKinds.has(s.kind);
    if (keep.has(ev)) started = true;
    if (isTalk && !keep.has(ev)) {
      skipped++;
      continue;
    }
    if (!started && isTalk) continue;
    renderEvent(ev);
    if (typeof ev.seq === 'number') lastSeq = Math.max(lastSeq, ev.seq);
  }
  if (skipped > 0 || !started) printDim(`以前の会話 ${skipped}件を省略 (/reload で全文表示)`);
}
printNotification('attached', `${sessionId.slice(0, 22)} · /quit to exit (session stays alive)`);

// ── live loop ───────────────────────────────────────────────────────────────

let running = false;
let runningSince = 0;
let frame = 0;

function renderSpinner() {
  if (!running) return;
  const secs = Math.floor((Date.now() - runningSince) / 1000);
  const glyph = accent(LOADER_FRAMES[frame % LOADER_FRAMES.length]);
  process.stdout.write(`\r  ${glyph} ${dim(`Thinking (${secs}s)`)}\x1b[K`);
  spinnerLine = true;
}

const spinTimer = setInterval(() => {
  frame++;
  renderSpinner();
}, 120);

const poll = async () => {
  try {
    const page = await client.pageEvents(sessionId, { maxMessages: 60 });
    for (const rec of page.records) {
      const ev = rec.event ?? rec;
      if (typeof ev.seq !== 'number' || ev.seq <= lastSeq) continue;
      renderEvent(ev);
      lastSeq = ev.seq;
    }
    const st = await client.state(sessionId);
    const nowRunning = Boolean(st.running);
    if (nowRunning && !running) {
      running = true;
      runningSince = Date.now();
      renderSpinner();
    } else if (!nowRunning && running) {
      running = false;
      clearSpinner();
      rl.prompt(true);
    } else if (running) {
      renderSpinner();
    }
  } catch (e) {
    printNotification('error', `poll: ${e.message}`);
  }
};
const pollTimer = setInterval(poll, 1200);

const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: `  ${BAR()} ` });
rl.prompt(true);
rl.on('line', async (line) => {
  const text = line.trim();
  if (!text) return rl.prompt(true);
  if (text === '/quit' || text === '/q') {
    clearInterval(pollTimer);
    clearInterval(spinTimer);
    clearSpinner();
    process.stdout.write('\r\x1b[K'); // erase the drawn prompt line
    printNotification('detached', 'session stays alive in the daemon');
    process.exit(0);
  }
  if (text === '/stop') {
    await client.cancel(sessionId);
    printNotification('cancel', 'requested');
    return rl.prompt(true);
  }
  if (text === '/resume') {
    // 直近のイベントを取り込み直す (画面の取りこぼし・復帰後の同期)
    const page = await client.pageEvents(sessionId, { maxMessages: 60 });
    for (const rec of page.records) {
      const ev = rec.event ?? rec;
      if (typeof ev.seq !== 'number' || ev.seq <= lastSeq) continue;
      renderEvent(ev);
      lastSeq = ev.seq;
    }
    printNotification('resumed', '最新の会話を取り込みました');
    return rl.prompt(true);
  }
  if (text === '/reload') {
    process.stdout.write('\x1b[2J\x1b[H');
    const page = await client.pageEvents(sessionId, { maxMessages: 80 });
    for (const rec of page.records) {
      const ev = rec.event ?? rec;
      renderEvent(ev);
    }
    printNotification('reloaded', `${page.records.length} events`);
    return rl.prompt(true);
  }
  if (text === '/help') {
    console.log(dim('  /resume  最新の会話を取り込み直す'));
    console.log(dim('  /reload  履歴を最初から描き直す'));
    console.log(dim('  /stop    実行中のターンを中断'));
    console.log(dim('  /quit    デタッチ (セッションは生き続ける)'));
    return rl.prompt(true);
  }
  if (text.startsWith('/')) {
    printNotification('error', `unknown command "${text.split(/\s+/)[0]}" — /help`);
    return rl.prompt(true);
  }
  if (text.startsWith('/model ')) {
    const [, provider, model, effort] = text.split(/\s+/);
    try {
      await client.selectModel(sessionId, provider, model, effort);
      printNotification('model', `${provider}/${model}${effort ? ' · ' + effort : ''}`);
    } catch (e) {
      printNotification('error', `model select: ${e.message}`);
    }
    return rl.prompt(true);
  }
  try {
    await client.prompt(sessionId, text);
  } catch (e) {
    printNotification('error', `send: ${e.message}`);
  }
  rl.prompt(true);
});rl.on('close', () => {
  clearInterval(pollTimer);
  clearInterval(spinTimer);
  clearSpinner();
  process.stdout.write('\r\x1b[K');
  console.log('');
  printNotification('detached', 'session stays alive in the daemon');
  process.exit(0);
});
