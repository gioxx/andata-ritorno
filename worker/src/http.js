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

/** Parse a JSON body, rejecting anything larger than maxBytes. */
export async function readJson(req, maxBytes = 65536) {
  const declared = Number(req.headers.get('content-length'));
  if (declared > maxBytes) throw new HttpError(413, 'too-large');
  const buf = await req.arrayBuffer();
  if (buf.byteLength > maxBytes) throw new HttpError(413, 'too-large');
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
