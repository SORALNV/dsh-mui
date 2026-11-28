// DSH host plugin for the documented llm/stream waterfall. The stock engine
// still owns range selection, checkpoint validation and history writes.
export const inject = ['llm'];
export const pluginId = 'mui-compaction-fallback';
const rateCodes = new Set(['RATE_LIMITED', 'RATE_LIMIT', 'QUOTA', 'ACCOUNT_QUOTA', 'QUOTA_EXCEEDED']);
const id = /^[\w.-]{1,128}$/;

export function parseFallbacks(routes, primary) {
  if (!Array.isArray(routes) || routes.length > 5) throw new Error('Specify at most five provider/model fallback pairs');
  const seen = new Set([primary]);
  return routes.map(route => {
    const [provider, model, extra] = typeof route === 'string' ? route.split('/') : [];
    if (extra !== undefined || !id.test(provider ?? '') || !id.test(model ?? '') || seen.has(provider)) {
      throw new Error('Each fallback must be provider/model with a distinct provider other than the primary');
    }
    seen.add(provider);
    return { provider, model };
  });
}

export function quotaFailure(failure) {
  if (!failure) return false;
  if (failure.status === 429 || rateCodes.has(failure.code)) return true;
  // Older adapters do not always provide a structured HTTP status.
  return failure.code === 'PROVIDER' && typeof failure.message === 'string'
    && /^(?:(?:HTTP\s+)?429\b|\{\s*"type"\s*:\s*"provider\.free-limit")/i.test(failure.message);
}

export async function* recoverSummary(options, initial, alternatives, dispatch, onFallback = () => {}) {
  let limited;
  const routes = [{ provider: options.provider, model: options.model }, ...alternatives];
  for (const [i, route] of routes.entries()) {
    options.signal?.throwIfAborted();
    const stream = i === 0 ? initial() : dispatch({ ...options, ...route });
    if (i > 0) onFallback(route);
    const buffered = [];
    let committed = false;
    let retry = false;
    for await (const chunk of stream) {
      options.signal?.throwIfAborted();
      if (!committed) {
        if (chunk.type === 'finish' && chunk.reason?.kind === 'error' && quotaFailure(chunk.reason.failure)) {
          limited = chunk;
          retry = true;
          break;
        }
        // A usage-only prefix is safe to discard. After any output or other
        // stream activity, pass through unchanged and don't retry the call.
        if (chunk.type === 'usage' && buffered.length < 8) {
          buffered.push(chunk);
          continue;
        }
        committed = true;
        yield* buffered;
      }
      yield chunk;
    }
    if (!retry) {
      if (!committed) yield* buffered;
      return;
    }
  }
  if (limited) yield limited;
}

export function apply(ctx, config) {
  const alternatives = parseFallbacks(config?.fallbacks, config?.provider);
  const retries = new WeakSet();
  const logger = ctx.logger;
  ctx.on('llm/stream', (options, next) => {
    if (options.purpose !== 'compaction' || options.provider !== config.provider || options.model !== config.model || retries.has(options)) return next();
    return recoverSummary(options, next, alternatives, request => {
      retries.add(request);
      return ctx.llm.stream(request);
    }, ({ provider, model }) => logger.warn(`Quota-limited compaction: trying approved backup ${provider}/${model}`));
  }, { global: true, prepend: true });
}
