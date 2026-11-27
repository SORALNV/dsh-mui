import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { apply, inject } from '../index.js';

const moduleEnv = 'MUI_COMPACTION_MANAGER_MODULE';
const profileEnv = 'MUI_COMPACTION_MANAGER_PROFILE';
const fixture = new URL('./fixture-manager.mjs', import.meta.url);
// DSH authenticates the owner before dispatch; the isolated integration test checks this boundary.
const route = '/api/mui-compaction-manager';

function host(t, path) {
  const restore = new Map([moduleEnv, profileEnv].map((key) => [key, process.env[key]]));
  const teardown = [];
  t.after(async () => {
    for (const [key, value] of restore) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const dispose of teardown) await dispose();
  });
  process.env[moduleEnv] = path;
  process.env[profileEnv] = 'fixture-scope';
  let handler;
  apply({
    effect: (fn) => teardown.push(fn()),
    connection: { fetch: { register(options) {
      assert.equal(options.path, route);
      handler = options.fetch;
      return () => { handler = undefined; };
    } } },
  });
  const dispatch = handler;
  return { handler: async (action, args) => (await dispatch(new Request(`http://localhost${route}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, args }),
  }))).json(), get registered() { return !!handler; }, dispose: () => teardown.shift()?.() };
}

test('host validates inputs and projects status without leaking private fields', async (t) => {
  assert.deepEqual(inject, ['connection']);
  const loaded = Symbol.for('mui.compaction-manager.test.fixture-loaded');
  const registration = host(t, fileURLToPath(fixture));
  const handler = registration.handler;
  assert.equal(globalThis[loaded], undefined);
  for (const [endpoint, body] of [
    ['getStatus', { profile: 'other' }], ['getStatus', { path: '/tmp/override' }],
    ['getStatus', []], ['doctor', {}], ['__proto__', {}], ['constructor', {}],
    ['set', { provider: 'bad/provider', model: 'm' }],
  ]) assert.equal((await handler(endpoint, body)).error.code, 'bad-request');
  assert.equal(globalThis[loaded], undefined);
  assert.deepEqual(await handler('getStatus', {}), {
    ok: true,
    value: {
      profile: 'fixture', provider: 'configured-provider', model: 'configured-model',
      enabled: true, applied: false, restartRequired: true,
      lastDiagnosis: { connection: 'catalog-available', compatible: true, contextWindow: null, probeOk: null, at: '2026-11-27T14:30:00.000Z' },
    },
  });
  assert.equal(globalThis[loaded], true);
  const { calls } = await import(fixture);
  assert.deepEqual(calls, [['status', [], { profile: 'fixture-scope' }]]);
  registration.dispose();
  assert.equal(registration.registered, false);
  assert.equal((await handler('getStatus', {})).error.code, 'cancelled');
});

test('missing or failed manager stays lazy and returns a redacted failure', async (t) => {
  const registration = host(t, fileURLToPath(new URL('./no-such-manager.mjs', import.meta.url)));
  assert.equal(registration.registered, true);
  assert.equal((await registration.handler('unknown', {})).error.code, 'bad-request');
  assert.deepEqual(await registration.handler('getStatus', {}), {
    ok: false, error: { code: 'unavailable', message: 'Compaction status is unavailable.', details: {} },
  });
});

test('client registers the formal settings slot and uses the fixed transport target', async () => {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
  let module;
  const calls = [];
  runInNewContext(source, { window: { __ModuleLoader__: { load: (x) => { module = x; } } },
    fetch: async (...args) => { calls.push(args); return { ok: true, json: () => ({ ok: true }) }; } });
  assert.equal(module.id, '@mui/compaction-manager');
  const plugin = module.factory((name) => {
    assert.equal(name, 'react');
    return { createElement() {} };
  });
  let options;
  plugin.apply({
    effect: (fn) => fn(),
    locale: { register: () => () => {}, bind: () => (key) => key },
    slots: {
      inject(name, fn) { assert.equal(name, 'settings.section'); fn(); },
      register(opts, view) { options = opts; assert.equal(typeof view, 'function'); },
    },
    connection: { rpc: { call(...args) { calls.push(args); } } },
  });
  assert.equal(options.name, 'settings.section');
  assert.equal(options.id, 'mui-compaction-manager');
  const signal = new AbortController().signal;
  await options.inject().getStatus(signal);
  assert.equal(calls[0][0], route.slice(1));
  assert.deepEqual(JSON.parse(calls[0][1].body), { action: 'getStatus', args: {} });
  assert.equal(calls[0][1].signal, signal);
});
