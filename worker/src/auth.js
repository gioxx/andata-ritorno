import { HttpError } from './http.js';

export async function sha256Hex(s) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 32 random bytes, base64url. */
export function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Resolve the calling device from `Authorization: Bearer <token>` and touch last_seen_at.
 * @returns {Promise<{deviceId: string, familyId: string}>}
 */
export async function requireDevice(env, req) {
  const m = /^Bearer (\S+)$/.exec(req.headers.get('authorization') || '');
  if (!m) throw new HttpError(401, 'unauthorized');
  const row = await env.DB.prepare('SELECT id, family_id FROM devices WHERE token_hash = ?')
    .bind(await sha256Hex(m[1]))
    .first();
  if (!row) throw new HttpError(401, 'unauthorized');
  await env.DB.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?')
    .bind(new Date().toISOString(), row.id)
    .run();
  return { deviceId: row.id, familyId: row.family_id };
}
