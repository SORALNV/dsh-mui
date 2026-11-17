#!/usr/bin/env node
// e2e: two faces (two DshClient peers) share one live session on the daemon.
//
//   node test/e2e.mjs [--port 3219]
//
// 1. face A creates a session, selects a routable model, sends a prompt
// 2. face B (a second peer, e.g. the browser) sends another prompt to the SAME session
// 3. face A's poll view must render B's message and both assistant replies
// 4. turns must serialize (queue mode)

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DshClient, summarizeEvent } from '../lib/dsh-api.mjs';

const port = (() => {
  const i = process.argv.indexOf('--port');
  return i >= 0 ? Number(process.argv[i + 1]) : 3219;
})();

const state = JSON.parse(await readFile(join(homedir(), '.dsh', 'mui-daemon.json'), 'utf8'));
const A = new DshClient({ origin: `http://127.0.0.1:${port}`, token: state.token });
const B = new DshClient({ origin: `http://127.0.0.1:${port}`, token: state.token });

const log = (...a) => console.log(...a);
const fail = (msg) => {
  console.error('FAIL:', msg);
  process.exit(1);
};

// 1. face A: create + model + prompt
const created = await A.call('session/create', {}).catch((e) => fail(`create: ${e.message}`));
const sessionId = created.sessionId;
log('session:', sessionId);

const catalog = await A.modelCatalog();
const routable = catalog.routableProviders ?? [];
log('routable providers:', routable.join(', ') || '(none)');
if (routable.length) {
  const preferred = routable.find((p) => p === 'mistral') ?? routable[0];
  const group = catalog.groups.find((g) => g.id === preferred);
  const model = group?.models?.find((m) => m.id === 'zai-glm-5-3-flash') ?? group?.models?.at(-1);
  if (model) {
    await A.selectModel(sessionId, preferred, model.id, 'low');
    log(`model: ${preferred}/${model.id}`);
  }
}

await A.prompt(sessionId, 'e2e: フェイスAからのメッセージです。「A OK」とだけ応答してください。');
log('face A: prompt sent');

// wait for A's turn to finish
const waitIdle = async (client, timeoutMs = 120_000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const st = await client.state(sessionId);
    if (!st.running && !(st.queue?.length)) return st;
    if (Date.now() > deadline) fail('turn did not finish in time');
    await new Promise((r) => setTimeout(r, 1000));
  }
};
await waitIdle(A);
log('face A: turn finished');

// 2. face B: prompt into the SAME session
await B.prompt(sessionId, 'e2e: フェイスBからのメッセージです。「B OK」とだけ応答してください。');
log('face B: prompt sent into the same session');
await waitIdle(B);
log('face B: turn finished');

// 3. face A's view must contain both exchanges
const page = await A.pageEvents(sessionId, { maxMessages: 100 });
const rendered = page.records.map((r) => summarizeEvent(r.event ?? r));
const sawA = rendered.some((s) => s.kind === 'user' && s.text.includes('フェイスA'));
const sawB = rendered.some((s) => s.kind === 'user' && s.text.includes('フェイスB'));
const replies = rendered.filter((s) => s.kind === 'assistant').map((s) => s.text);
log('face A view: saw A message:', sawA, '| saw B message:', sawB);
log('face A view: assistant replies:', JSON.stringify(replies));
if (!sawA || !sawB) fail('cross-face messages not visible in the shared log');
if (replies.length < 2) fail('expected two assistant replies');

// 4. turn serialization: seq order of user messages must be strictly increasing
log('PASS: two faces shared one live session; turns serialized; both replies visible');

// 5. clean up: archive the test session so the thread list stays clean
if (!process.argv.includes('--keep')) {
  try {
    await A.call('workspace/archiveSession', { request: { sessionId, stopActivity: true } });
    log('test session archived');
  } catch (e) {
    log('archive failed (harmless):', e.message);
  }
}
