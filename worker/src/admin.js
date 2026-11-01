import { HttpError, json, readJson } from './http.js';

// The owner's dashboard: aggregate numbers only, never encrypted content, names or hashes.
// Cloudflare Access sits in front of /admin.html and /api/admin/*; this Worker checks the Access
// token itself as well, so the numbers stay private even if the Access application is misconfigured.
// Without ACCESS_TEAM_DOMAIN and ACCESS_AUD the route does not exist.

const b64urlBytes = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));
const decodePart = (s) => JSON.parse(new TextDecoder().decode(b64urlBytes(s)));

let certs = { domain: null, keys: null, at: 0 };
const CERTS_TTL_MS = 60 * 60 * 1000;

async function accessKeys(domain, fetchFn, kid) {
  // A kid not in the cache means Access rotated its keys: fetch again rather than wait out the TTL.
  // At most once a minute, so made-up kids cannot turn every request into a fetch.
  const age = Date.now() - certs.at;
  const fresh = certs.domain === domain && age < CERTS_TTL_MS && (certs.keys.some((k) => k.kid === kid) || age < 60 * 1000);
  if (fresh) return certs.keys;
  const res = await fetchFn(`https://${domain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`access certs ${res.status}`);
  certs = { domain, keys: (await res.json()).keys ?? [], at: Date.now() };
  return certs.keys;
}

/**
 * Verify the Cf-Access-Jwt-Assertion header (RS256, signed by the team's Access keys, for this
 * application's audience, not expired). Throws 404 when admin is off or the token is not valid,
 * so the route looks absent to anyone else.
 * @returns {Promise<string>} the authenticated email
 */
export async function requireAdmin(env, req, fetchFn = fetch) {
  const domain = env.ACCESS_TEAM_DOMAIN;
  const aud = env.ACCESS_AUD;
  const hidden = new HttpError(404, 'not-found');
  if (!domain || !aud) throw hidden;
  const jwt = req.headers.get('cf-access-jwt-assertion') ?? '';
  const parts = jwt.split('.');
  if (parts.length !== 3) throw hidden;
  let header, payload;
  try {
    header = decodePart(parts[0]);
    payload = decodePart(parts[1]);
  } catch {
    throw hidden;
  }
  if (header.alg !== 'RS256') throw hidden;
  const jwk = (await accessKeys(domain, fetchFn, header.kid)).find((k) => k.kid === header.kid);
  if (!jwk) throw hidden;
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlBytes(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  const now = Date.now() / 1000;
  if (!ok || !auds.includes(aud) || payload.iss !== `https://${domain}` || !(payload.exp > now) || typeof payload.email !== 'string') throw hidden;
  return payload.email;
}

const DAY_MS = 24 * 60 * 60 * 1000;

async function stats(req, env) {
  await requireAdmin(env, req);
  const ago = (days) => new Date(Date.now() - days * DAY_MS).toISOString();
  const one = (sql, ...args) => env.DB.prepare(sql).bind(...args);
  const [families, devices, licences, codes, months, records, photos, usage, invites, settings] = await env.DB.batch([
    one('SELECT COUNT(*) AS total, SUM(created_at >= ?) AS new30 FROM families', ago(30)),
    one(
      `SELECT COUNT(*) AS total, SUM(last_seen_at >= ?) AS active1, SUM(last_seen_at >= ?) AS active7, SUM(last_seen_at >= ?) AS active30
       FROM devices`,
      ago(1),
      ago(7),
      ago(30),
    ),
    one('SELECT COUNT(*) AS total, SUM(family_id IS NOT NULL) AS inUse, COALESCE(SUM(extra_slots), 0) AS extraSlots FROM licences'),
    one(
      `SELECT kind, source, COUNT(*) AS issued, SUM(redeemed_at IS NOT NULL) AS redeemed, SUM(created_at >= ?) AS last30
       FROM codes GROUP BY kind, source ORDER BY kind, source`,
      ago(30),
    ),
    one(
      `SELECT substr(created_at, 1, 7) AS month, SUM(kind = 'family') AS family, SUM(kind = 'slot') AS slot
       FROM codes WHERE source = 'stripe' GROUP BY month ORDER BY month DESC LIMIT 12`,
    ),
    one('SELECT COUNT(*) AS total FROM records'),
    one('SELECT SUM(ready = 1) AS ready, SUM(ready = 0) AS pending, COALESCE(SUM(size), 0) AS bytes FROM photos'),
    one("SELECT bytes FROM usage WHERE key = 'photo_bytes'"),
    one('SELECT COUNT(*) AS open FROM invites WHERE used_at IS NULL AND expires_at > ?', new Date().toISOString()),
    one("SELECT value FROM settings WHERE key = 'registrations'"),
  ]);
  const row = (r) => r.results[0] ?? {};
  const cap = Number(env.MAX_TOTAL_PHOTO_BYTES);
  return json({
    at: new Date().toISOString(),
    families: row(families),
    devices: row(devices),
    licences: row(licences),
    codes: codes.results,
    salesByMonth: months.results,
    records: row(records).total ?? 0,
    photos: { ...row(photos), counted: row(usage).bytes ?? 0, cap: Number.isFinite(cap) ? cap : null },
    openInvites: row(invites).open ?? 0,
    registrationsOpen: row(settings).value !== 'closed',
  });
}

/** Open or close registrations (see requireRegistrationsOpen). Body: {open: boolean}. */
async function setRegistrations(req, env) {
  await requireAdmin(env, req);
  // The Access cookie rides along on cross-site requests too: accept only same-origin JSON, which
  // a form on another site cannot send without a CORS preflight this Worker never answers.
  const origin = req.headers.get('origin');
  const type = req.headers.get('content-type') ?? '';
  if (origin !== new URL(req.url).origin || !type.startsWith('application/json')) throw new HttpError(404, 'not-found');
  const { open } = (await readJson(req, 1024)) ?? {};
  if (typeof open !== 'boolean') throw new HttpError(400, 'bad-request');
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('registrations', ?1) ON CONFLICT(key) DO UPDATE SET value = ?1")
    .bind(open ? 'open' : 'closed')
    .run();
  return json({ registrationsOpen: open });
}

export const adminRoutes = {
  'GET /api/admin/stats': stats,
  'POST /api/admin/registrations': setRegistrations,
};
