export class HttpError extends Error {
  /**
   * @param {number} status
   * @param {string} code machine-readable error code returned as `{error: code}`
   * @param {object} [extra] additional JSON fields
   */
  constructor(status, code, extra) {
    super(code);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/**
 * Read a request body, stopping as soon as it exceeds maxBytes (so a chunked body without
 * Content-Length is never fully buffered). Throws HttpError(413, code) when too large.
 * @returns {Promise<Uint8Array>}
 */
export async function readBody(req, maxBytes, code = 'too-large') {
  if (Number(req.headers.get('content-length')) > maxBytes) throw new HttpError(413, code);
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new HttpError(413, code);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

/** Parse a JSON body, rejecting anything larger than maxBytes. */
export async function readJson(req, maxBytes = 65536) {
  const buf = await readBody(req, maxBytes);
  try {
    return JSON.parse(new TextDecoder().decode(buf));
  } catch {
    throw new HttpError(400, 'bad-request');
  }
}

/**
 * Match a request against a table keyed by "METHOD /path/:param".
 * @param {Request} req
 * @param {Record<string, Function>} table
 * @returns {{handler: Function, params: Record<string,string>} | null}
 */
export function route(req, table) {
  const path = new URL(req.url).pathname.split('/');
  for (const [key, handler] of Object.entries(table)) {
    const [method, pattern] = key.split(' ');
    if (method !== req.method) continue;
    const parts = pattern.split('/');
    if (parts.length !== path.length) continue;
    const params = {};
    const ok = parts.every((p, i) => {
      if (p.startsWith(':')) {
        params[p.slice(1)] = decodeURIComponent(path[i]);
        return path[i] !== '';
      }
      return p === path[i];
    });
    if (ok) return { handler, params };
  }
  return null;
}

/** Rate limiting is optional: without the binding there is simply no limiting. */
export async function limited(binding, key) {
  if (!binding) return false;
  const { success } = await binding.limit({ key });
  return !success;
}

/** The tight per-IP bucket for unauthenticated routes that check a secret or a code. */
export async function strictLimit(env, req) {
  if (await limited(env.RL_STRICT, req.headers.get('cf-connecting-ip') || 'unknown')) throw new HttpError(429, 'rate-limited');
}
