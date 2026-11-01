import { HttpError, clientIp, limited } from './http.js';

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
// IPs that ran out of failed-auth attempts, until when (ms). Kept in the isolate, so a blocked IP
// is turned away before any database query; the rate limiter stays the source of truth.
const blockedIps = new Map();
const BLOCK_MS = 60 * 1000;
const MAX_BLOCKED = 10_000;
// Token hashes this isolate recently found valid: a phone that shares its IP with a misbehaving
// client (mobile carriers, offices) keeps working while that IP is blocked.
const knownTokens = new Map();
const KNOWN_MS = 30 * 60 * 1000;
const MAX_KNOWN = 10_000;

function remember(map, key, until, max) {
  if (map.size >= max && !map.has(key)) map.delete(map.keys().next().value);
  map.set(key, until);
}

export async function requireDevice(env, req) {
  // Device routes skip the per-IP limit (a family's phones may share one IP). Failed attempts do
  // not: an IP that keeps sending wrong tokens gets the tight bucket, so tokens cannot be guessed
  // and the database is not used as a punching bag.
  const ip = clientIp(req);
  const now = Date.now();
  const m = /^Bearer ([A-Za-z0-9_-]{8,200})$/.exec(req.headers.get('authorization') || '');
  const hash = m ? await sha256Hex(m[1]) : null;
  // A blocked IP is turned away before the database, unless the token was valid here recently.
  if ((blockedIps.get(ip) ?? 0) > now && !((knownTokens.get(hash) ?? 0) > now)) throw new HttpError(429, 'rate-limited');
  const refuse = async () => {
    if (await limited(env.RL_STRICT, `auth:${ip}`)) {
      remember(blockedIps, ip, now + BLOCK_MS, MAX_BLOCKED);
      throw new HttpError(429, 'rate-limited');
    }
    throw new HttpError(401, 'unauthorized');
  };
  if (!hash) return refuse();
  const row = await env.DB.prepare('SELECT id, family_id, last_seen_at FROM devices WHERE token_hash = ?').bind(hash).first();
  if (!row) {
    knownTokens.delete(hash);
    return refuse();
  }
  remember(knownTokens, hash, now + KNOWN_MS, MAX_KNOWN);
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
