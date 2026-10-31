import { HttpError, limited } from './http.js';

export async function sha256Hex(s) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** HMAC-SHA256 of msg under key, hex. */
export async function hmacHex(key, msg) {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k, enc.encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 32 random bytes, base64url. */
export function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const SEEN_EVERY_MS = 10 * 60 * 1000;

/**
 * Resolve the calling device from `Authorization: Bearer <token>` and touch last_seen_at (at most
 * every 10 minutes: a sync makes many calls, and D1's free plan caps writes per day).
 * @returns {Promise<{deviceId: string, familyId: string}>}
 */
export async function requireDevice(env, req) {
  const m = /^Bearer (\S+)$/.exec(req.headers.get('authorization') || '');
  if (!m) throw new HttpError(401, 'unauthorized');
  const row = await env.DB.prepare('SELECT id, family_id, last_seen_at FROM devices WHERE token_hash = ?')
    .bind(await sha256Hex(m[1]))
    .first();
  if (!row) throw new HttpError(401, 'unauthorized');
  const now = Date.now();
  if (!(now - Date.parse(row.last_seen_at) < SEEN_EVERY_MS)) {
    await env.DB.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?')
      .bind(new Date(now).toISOString(), row.id)
      .run();
  }
  return { deviceId: row.id, familyId: row.family_id };
}

/** requireDevice plus the per-device API rate limit (a no-op when RL_API is not bound). */
export async function requireApiDevice(env, req) {
  const dev = await requireDevice(env, req);
  if (await limited(env.RL_API, `device:${dev.deviceId}`)) throw new HttpError(429, 'rate-limited');
  return dev;
}
