import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

export const inject = ['connection'];
const ROUTE = '/api/mui-compaction-manager';
const DEFAULT_MODULE = new URL('../../lib/compaction.mjs', import.meta.url);

const fail = (code, message) => ({ ok: false, error: { code, message, details: {} } });
const isId = (value) => typeof value === 'string' && /^[\w.-]{1,128}$/.test(value)
  && value !== '.' && value !== '..';
const connectionStates = new Set(['not-running', 'catalog-available', 'model-unavailable', 'unreachable']);

function publicStatus(status) {
  if (!status || !isId(status.profile) || !isId(status.provider) || !isId(status.model)
    || typeof status.enabled !== 'boolean' || typeof status.applied !== 'boolean'
    || typeof status.restartRequired !== 'boolean') throw new Error('Invalid manager status');
  const last = status.lastDiagnosis;
  const lastDiagnosis = last && connectionStates.has(last.connection) ? {
    connection: last.connection,
    compatible: typeof last.compatibility?.ok === 'boolean' ? last.compatibility.ok : null,
    contextWindow: Number.isSafeInteger(last.contextWindow) && last.contextWindow > 0 ? last.contextWindow : null,
    probeOk: typeof last.probe?.ok === 'boolean' ? last.probe.ok : null,
    at: typeof last.at === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(last.at) ? last.at : null,
  } : null;
  return {
    profile: status.profile, provider: status.provider, model: status.model,
    enabled: status.enabled, applied: status.applied, restartRequired: status.restartRequired,
    lastDiagnosis,
  };
}

export function apply(ctx) {
  // Startup environment belongs to the operator; no browser request may override it.
  const modulePath = process.env.MUI_COMPACTION_MANAGER_MODULE;
  const profile = process.env.MUI_COMPACTION_MANAGER_PROFILE || process.env.DSH_PROFILE || undefined;
  let manager;
  function loadManager() {
    if (!manager) {
      if (modulePath && !isAbsolute(modulePath)) throw new Error('Manager path must be absolute');
      manager = import(modulePath ? pathToFileURL(modulePath) : DEFAULT_MODULE).then((mod) => {
        if (typeof mod.manage !== 'function') throw new Error('The manager must export manage()');
        return mod.manage;
      });
      manager.catch(() => { manager = undefined; });
    }
    return manager;
  }

  let active = true;
  async function dispatch(endpoint, body, signal) {
      const actions = new Map([['getStatus', 'status'], ['enable', 'enable'], ['disable', 'disable'], ['set', 'set'], ['sync', 'sync'], ['rollback', 'rollback']]);
      const action = actions.get(endpoint);
      const validBody = body !== null && typeof body === 'object' && !Array.isArray(body);
      if (!action || !validBody || (action === 'set'
        ? Object.keys(body).length !== 2 || !isId(body.provider) || !isId(body.model)
        : Object.keys(body).length !== 0)) {
        return fail('bad-request', 'Invalid Compaction Manager request.');
      }
      try {
        if (!active || signal?.aborted) return fail('cancelled', 'The status request was cancelled.');
        const manage = await loadManager();
        if (!active || signal?.aborted) return fail('cancelled', 'The status request was cancelled.');
        if (action !== 'status') await manage(action, action === 'set' ? [body.provider, body.model] : [], { profile });
        const status = await manage('status', [], { profile });
        if (!active || signal?.aborted) return fail('cancelled', 'The status request was cancelled.');
        return { ok: true, value: publicStatus(status) };
      } catch {
        // Runtime errors can include local paths and implementation details.
        return fail('unavailable', 'Compaction status is unavailable.');
      }
  }
  const unregister = ctx.connection.fetch.register({
    path: ROUTE, methods: ['POST'], requestBody: 'buffered',
    async fetch(request) {
      if (request.headers.get('content-type')?.split(';')[0] !== 'application/json') {
        return Response.json(fail('bad-request', 'Expected JSON.'), { status: 400 });
      }
      const body = await request.json().catch(() => null);
      if (typeof body?.action !== 'string' || Object.keys(body).length !== 2) {
        return Response.json(fail('bad-request', 'Invalid Compaction Manager request.'), { status: 400 });
      }
      return Response.json(await dispatch(body.action, body.args, request.signal), { headers: { 'cache-control': 'no-store' } });
    },
  });
  ctx.effect(() => () => {
    active = false;
    return unregister();
  });
}
