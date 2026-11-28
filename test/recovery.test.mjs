import assert from 'node:assert/strict';
import test from 'node:test';
import { apply, parseFallbacks, quotaFailure, recoverSummary } from '../lib/compaction-fallback.mjs';
import { recoverInference } from '../lib/recovery.mjs';

const chunks = async function* (...items) { yield* items; };
const rate = { type: 'finish', reason: { kind: 'error', failure: { status: 429 } } };
const auth = { type: 'finish', reason: { kind: 'error', failure: { status: 401 } } };
const usage = { type: 'usage', inputTokens: 123 };
const output = { type: 'text-delta', text: 'summary' };
const options = { provider: 'main', model: 'm', purpose: 'compaction' };
const alternatives = parseFallbacks(['backup/one', 'extra/two'], options.provider);
const collect = async stream => { const out = []; for await (const item of stream) out.push(item); return out; };

test('only distinct explicitly configured routes are accepted', () => {
  for (const list of [['main/other'], ['x/one', 'x/two'], ['x'], ['x/a/b'], ['x/']]) assert.throws(() => parseFallbacks(list, 'main'));
  assert.equal(quotaFailure({ code: 'PROVIDER', message: '429: quota' }), true);
  assert.equal(quotaFailure({ code: 'CONTEXT_WINDOW_EXCEEDED', message: '429 tokens' }), false);
});

test('quota discards only usage prefix and follows the approved order', async () => {
  const calls = [];
  const result = await collect(recoverSummary(options, () => chunks(usage, rate), alternatives, req => {
    calls.push(req);
    return req.provider === 'backup' ? chunks(rate) : chunks(output);
  }));
  assert.deepEqual(calls, alternatives.map(route => ({ ...options, ...route })));
  assert.deepEqual(result, [output]);
});

test('all limited propagates the terminal error; no retry after output, auth or abort', async () => {
  assert.deepEqual(await collect(recoverSummary(options, () => chunks(rate), alternatives, () => chunks(rate))), [rate]);
  for (const prefix of [[output, rate], [auth]]) {
    assert.deepEqual(await collect(recoverSummary(options, () => chunks(...prefix), alternatives, () => assert.fail('retried'))), prefix);
  }
  const signal = AbortSignal.abort();
  await assert.rejects(collect(recoverSummary({ ...options, signal }, () => assert.fail('dispatched'), alternatives, () => assert.fail('retried'))), { name: 'AbortError' });
});

test('normal inference and unrelated summary models pass through', () => {
  let hook;
  apply({ logger: {}, on: (_name, fn) => { hook = fn; } }, { ...options, fallbacks: ['backup/one'] });
  assert.equal(hook({ ...options, purpose: undefined }, () => 'original'), 'original');
  assert.equal(hook({ ...options, model: 'other' }, () => 'original'), 'original');
});

test('inference recovery excludes the limited provider and never resends a prompt', async () => {
  const calls = [];
  const client = {
    modelCatalog: async () => ({ routableProviders: ['main', 'backup'], groups: ['main', 'backup', 'offline'].map(id => ({ id, models: [{ id: 'm' }] })) }),
    selectModel: async (...args) => { calls.push(args); },
  };
  assert.deepEqual(await recoverInference(client, 'candidates', ['main']), { excluded: 'main', candidates: ['backup/m'] });
  await assert.rejects(recoverInference(client, 'switch', ['id', 'main', 'main/m']));
  await assert.rejects(recoverInference(client, 'switch', ['id', 'main', 'offline/m']));
  assert.equal((await recoverInference(client, 'switch', ['id', 'main', 'backup/m'])).promptResent, false);
  assert.deepEqual(calls, [['id', 'backup', 'm']]);
});
