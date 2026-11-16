// Shared DSH Web-Host API client for MUI faces.
// Speaks the /api bridge: launch-token → signed-cookie exchange, then RPC.
//
// Envelope quirks (empirically verified against dsh 0.2.2-rc.1):
//   most methods take { request: {...} }        (session/page, session/prompt, session/state, session/create, session/selectModel)
//   session/list takes { _request: {...} }

const ENVELOPES = {
  'session/list': (a) => ({ _request: a.request ?? {} }),
  'session/modelCatalog': (a) => a,
};

export class DshApiError extends Error {
  constructor(method, code, message) {
    super(`${method}: ${code}: ${message}`);
    this.code = code;
  }
}

export class DshClient {
  constructor({ origin, token, fetchImpl = globalThis.fetch }) {
    this.origin = origin.replace(/\/$/, '');
    this.token = token;
    this.fetch = fetchImpl;
    this.cookie = undefined;
    this.rpcId = 0;
  }

  /** Exchange the launch token for the signed session cookie. Idempotent. */
  async auth() {
    const res = await this.fetch(`${this.origin}/?token=${encodeURIComponent(this.token)}`, {
      redirect: 'manual',
    });
    if (res.status !== 303) throw new DshApiError('auth', String(res.status), 'token exchange failed');
    const cookies = res.headers.getSetCookie?.() ?? [];
    const line = cookies[0] ?? '';
    const pair = line.split(';')[0];
    if (!pair.includes('=')) throw new DshApiError('auth', 'cookie', 'no cookie minted');
    this.cookie = pair;
    return this.cookie;
  }

  async #raw(method, payload) {
    if (!this.cookie) await this.auth();
    const res = await this.fetch(`${this.origin}/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: this.cookie },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: `${++this.rpcId}-mui`,
        method,
        payload,
      }),
    });
    if (res.status === 401) {
      // cookie expired/rotated → re-mint once
      this.cookie = undefined;
      await this.auth();
      return this.#raw(method, payload);
    }
    const json = await res.json().catch(() => ({}));
    if (json?.type === 'server-response' && json.result) return json.result;
    throw new DshApiError(method, 'protocol', JSON.stringify(json).slice(0, 300));
  }

  async call(method, args = {}) {
    const wrap = ENVELOPES[method] ?? ((a) => ({ request: a }));
    const result = await this.#raw(method, { args: wrap(args) });
    if (!result.ok) {
      const e = result.error ?? {};
      throw new DshApiError(method, e.code ?? 'error', e.message ?? '');
    }
    return result.value;
  }

  // ── Typed helpers ────────────────────────────────────────────────────────

  listSessions() {
    return this.call('session/list', { request: {} });
  }

  pageEvents(sessionId, { maxMessages = 60 } = {}) {
    return this.call('session/page', {
      address: { kind: 'session', sessionId },
      maxMessages,
    });
  }

  state(sessionId) {
    return this.call('session/state', { sessionId });
  }

  prompt(sessionId, text, { mode = 'queue' } = {}) {
    return this.call('session/prompt', {
      requestId: crypto.randomUUID(),
      sessionId,
      mode,
      content: [{ type: 'text', text }],
      clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
  }

  cancel(sessionId) {
    return this.call('session/cancel', { sessionId }).catch(() => undefined);
  }

  selectModel(sessionId, provider, model, reasoningEffort) {
    return this.call('session/selectModel', {
      sessionId,
      provider,
      model,
      ...(reasoningEffort ? { reasoningEffort } : {}),
    });
  }

  modelCatalog() {
    return this.call('session/modelCatalog', {});
  }
}

// ── Event shaping ──────────────────────────────────────────────────────────

/** Flatten a message event's content parts into plain text. */
export function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (part?.type === 'text' ? part.text : part?.type === 'image' ? '[image]' : ''))
    .filter(Boolean)
    .join('\n');
}

/** Extract a compact, renderable summary of one session event. */
export function summarizeEvent(event) {
  const { type, seq, data = {} } = event;
  switch (type) {
    case 'user/message':
      return { kind: 'user', seq, text: contentText(data.content) };
    case 'assistant/message':
      return { kind: 'assistant', seq, text: contentText(data.message?.content ?? data.content) };
    case 'turn/start':
      return { kind: 'turn-start', seq };
    case 'turn/end':
      return { kind: 'turn-end', seq };
    case 'session/title':
      return { kind: 'title', seq, text: data.title ?? '' };
    case 'model/selection':
      return { kind: 'model', seq, text: [data.provider, data.model].filter(Boolean).join('/') };
    default:
      return { kind: 'other', seq, type };
  }
}
