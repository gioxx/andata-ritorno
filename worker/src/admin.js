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
const RANGES = [7, 30, 90, 365];
// List prices, for an estimate of gross sales (Stripe, as merchant of record, keeps its share).
const PRICE_EUR = { family: 4.99, slot: 1.99 };

/**
 * Dashboard numbers for the last `days` (7, 30, 90 or 365) and the period before it, bucketed by
 * day (by month for a year). Aggregates only: counts, sums and histograms, never one row's content.
 */
async function stats(req, env) {
  await requireAdmin(env, req);
  const asked = Number(new URL(req.url).searchParams.get('days'));
  const days = RANGES.includes(asked) ? asked : 30;
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  // Calendar-aligned, like the dashboard's buckets: the last `days` UTC days including today, or
  // the last 12 months including this one.
  const today = new Date(now);
  const startOf = (y, m, d) => Date.UTC(y, m, d);
  const byMonth = days > 90;
  const fromMs = byMonth ? startOf(today.getUTCFullYear(), today.getUTCMonth() - 11, 1) : startOf(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - (days - 1));
  // The previous period lasts exactly as long as the current one, which ends now (today is partial).
  const prevMs = fromMs - (now - fromMs);
  const from = iso(fromMs);
  const prevFrom = iso(prevMs);
  const bucket = byMonth ? 7 : 10; // substr length: YYYY-MM or YYYY-MM-DD
  const one = (sql, ...args) => env.DB.prepare(sql).bind(...args);
  const [families, devices, licences, codes, newFamilies, newDevices, seenDevices, codesByDay, salesByMonth, perFamily, records, photos, usage, invites, settings, budget] =
    await env.DB.batch([
      one('SELECT COUNT(*) AS total, SUM(created_at >= ?1) AS inRange, SUM(created_at >= ?2 AND created_at < ?1) AS prevRange FROM families', from, prevFrom),
      one(
        `SELECT COUNT(*) AS total, SUM(created_at >= ?1) AS inRange, SUM(created_at >= ?2 AND created_at < ?1) AS prevRange,
           SUM(last_seen_at >= ?3) AS active1, SUM(last_seen_at >= ?4) AS active7, SUM(last_seen_at >= ?5) AS active30, SUM(last_seen_at >= ?1) AS activeInRange
         FROM devices`,
        from, prevFrom, iso(now - DAY_MS), iso(now - 7 * DAY_MS), iso(now - 30 * DAY_MS),
      ),
      one('SELECT COUNT(*) AS total, SUM(family_id IS NOT NULL) AS inUse, COALESCE(SUM(extra_slots), 0) AS extraSlots FROM licences'),
      one(
        `SELECT kind, source, COUNT(*) AS issued, SUM(redeemed_at IS NOT NULL) AS redeemed,
           SUM(created_at >= ?1) AS inRange, SUM(created_at >= ?2 AND created_at < ?1) AS prevRange
         FROM codes GROUP BY kind, source ORDER BY kind, source`,
        from, prevFrom,
      ),
      one(`SELECT substr(created_at, 1, ?2) AS b, COUNT(*) AS n FROM families WHERE created_at >= ?1 GROUP BY b ORDER BY b`, from, bucket),
      one(`SELECT substr(created_at, 1, ?2) AS b, COUNT(*) AS n FROM devices WHERE created_at >= ?1 GROUP BY b ORDER BY b`, from, bucket),
      one(`SELECT substr(last_seen_at, 1, ?2) AS b, COUNT(*) AS n FROM devices WHERE last_seen_at >= ?1 GROUP BY b ORDER BY b`, from, bucket),
      one(
        `SELECT substr(created_at, 1, ?2) AS b, kind, source, COUNT(*) AS issued FROM codes WHERE created_at >= ?1 GROUP BY b, kind, source ORDER BY b`,
        from, bucket,
      ),
      one(
        `SELECT substr(created_at, 1, 7) AS month, SUM(kind = 'family') AS family, SUM(kind = 'slot') AS slot
         FROM codes WHERE source = 'stripe' GROUP BY month ORDER BY month DESC LIMIT 12`,
      ),
      // One row per family: phones, records, photo bytes. Only the histograms below leave the Worker.
      one(
        `SELECT (SELECT COUNT(*) FROM devices d WHERE d.family_id = f.id) AS phones,
           (SELECT COUNT(*) FROM records r WHERE r.family_id = f.id) AS records,
           (SELECT COALESCE(SUM(size), 0) FROM photos p WHERE p.family_id = f.id) AS bytes
         FROM families f`,
      ),
      one('SELECT COUNT(*) AS total FROM records'),
      one('SELECT SUM(ready = 1) AS ready, SUM(ready = 0) AS pending, COALESCE(SUM(size), 0) AS bytes FROM photos'),
      one("SELECT bytes FROM usage WHERE key = 'photo_bytes'"),
      one('SELECT COUNT(*) AS open FROM invites WHERE used_at IS NULL AND expires_at > ?', iso(now)),
      one("SELECT value FROM settings WHERE key = 'registrations'"),
      one('SELECT COUNT(*) AS devices, MAX(units) AS top, SUM(units) AS units FROM device_usage WHERE day = ?', iso(now).slice(0, 10)),
    ]);
  const row = (r) => r.results[0] ?? {};
  const cap = Number(env.MAX_TOTAL_PHOTO_BYTES);
  const hist = (values, edges) => edges.map(([label, lo, hi]) => ({ label, n: values.filter((v) => v >= lo && v < hi).length }));
  const fams = perFamily.results;
  const sold = (r) => r.family * PRICE_EUR.family + r.slot * PRICE_EUR.slot;
  return json({
    at: iso(now),
    days,
    bucket: bucket === 7 ? 'month' : 'day',
    families: row(families),
    devices: row(devices),
    licences: row(licences),
    codes: codes.results,
    series: {
      newFamilies: newFamilies.results,
      newDevices: newDevices.results,
      lastSeen: seenDevices.results,
      codes: codesByDay.results,
    },
    salesByMonth: salesByMonth.results.map((r) => ({ ...r, eur: Math.round(sold(r) * 100) / 100 })),
    distributions: {
      phones: hist(fams.map((f) => f.phones), [['0', 0, 1], ['1', 1, 2], ['2', 2, 3], ['3', 3, 4], ['4', 4, 5], ['5+', 5, Infinity]]),
      records: hist(fams.map((f) => f.records), [['0–49', 0, 50], ['50–199', 50, 200], ['200–499', 200, 500], ['500–1999', 500, 2000], ['2000+', 2000, Infinity]]),
      photoMB: hist(fams.map((f) => f.bytes / 1e6), [['< 10 MB', 0, 10], ['10–50', 10, 50], ['50–100', 50, 100], ['100–200', 100, 200], ['200–300', 200, Infinity]]),
    },
    records: row(records).total ?? 0,
    photos: { ...row(photos), counted: row(usage).bytes ?? 0, cap: Number.isFinite(cap) ? cap : 9_000_000_000 },
    openInvites: row(invites).open ?? 0,
    budgetToday: row(budget),
    registrationsOpen: row(settings).value !== 'closed',
  });
}

// Free-plan allowances the dashboard compares usage with (Workers Free, D1, R2, Resend Free).
// Change them here if the account moves to a paid plan.
const LIMITS = {
  workerRequestsDay: 100_000,
  d1RowsReadDay: 5_000_000,
  d1RowsWrittenDay: 100_000,
  r2ClassAMonth: 1_000_000,
  r2ClassBMonth: 10_000_000,
  r2StorageBytes: 10_000_000_000,
  emailsDay: 100,
  emailsMonth: 3_000,
};
// R2 operations by billing class (developers.cloudflare.com/r2/pricing). Deletes and aborted
// uploads are free and are not counted in either class.
const R2_CLASS_A = new Set(['ListBuckets', 'PutBucket', 'ListObjects', 'ListObjectsV2', 'PutObject', 'CopyObject', 'CompleteMultipartUpload', 'CreateMultipartUpload', 'LifecycleStorageTierTransition', 'ListMultipartUploads', 'UploadPart', 'UploadPartCopy', 'ListParts', 'PutBucketEncryption', 'PutBucketCors', 'PutBucketLifecycleConfiguration']);
const R2_CLASS_B = new Set(['HeadBucket', 'HeadObject', 'GetObject', 'UsageSummary', 'GetBucketEncryption', 'GetBucketLocation', 'GetBucketCors', 'GetBucketLifecycleConfiguration']);

const USAGE_QUERY = `query ($account: String!, $db: String!, $script: String!, $bucket: String!, $from: Date!, $to: Date!, $fromT: Time!, $toT: Time!) {
  viewer { accounts(filter: { accountTag: $account }) {
    d1: d1AnalyticsAdaptiveGroups(limit: 100, filter: { databaseId: $db, date_geq: $from, date_leq: $to }) {
      dimensions { date } sum { readQueries writeQueries rowsRead rowsWritten }
    }
    worker: workersInvocationsAdaptive(limit: 100, filter: { scriptName: $script, date_geq: $from, date_leq: $to }) {
      dimensions { date } sum { requests errors subrequests }
    }
    r2ops: r2OperationsAdaptiveGroups(limit: 1000, filter: { bucketName: $bucket, datetime_geq: $fromT, datetime_leq: $toT }) {
      dimensions { actionType } sum { requests }
    }
    r2size: r2StorageAdaptiveGroups(limit: 1, filter: { bucketName: $bucket, datetime_geq: $fromT, datetime_leq: $toT }, orderBy: [datetime_DESC]) {
      dimensions { datetime } max { payloadSize metadataSize objectCount }
    }
  } }
}`;

/**
 * Resources used, for the dashboard: Cloudflare's own analytics (Worker requests, D1 rows, R2
 * operations and storage; needs CF_ANALYTICS_TOKEN with Account Analytics: Read and CF_ACCOUNT_ID)
 * and the emails this Worker sent through Resend. Last 30 days by day, with the free-plan limits.
 */
async function usage(req, env, ctx, params, fetchFn = fetch) {
  await requireAdmin(env, req);
  const now = new Date();
  const day = (ms) => new Date(ms).toISOString().slice(0, 10);
  const from = day(now.getTime() - 29 * DAY_MS);
  const to = day(now.getTime());
  const month = to.slice(0, 7);
  const emails = await env.DB.prepare('SELECT day, n FROM email_usage WHERE day >= ? ORDER BY day').bind(from).all();
  const monthEmails = await env.DB.prepare('SELECT COALESCE(SUM(n), 0) AS n FROM email_usage WHERE day >= ?').bind(`${month}-01`).first();
  const out = {
    limits: LIMITS,
    emails: { byDay: emails.results, today: emails.results.find((r) => r.day === to)?.n ?? 0, month: monthEmails?.n ?? 0 },
    cloudflare: null,
  };
  if (!env.CF_ANALYTICS_TOKEN || !env.CF_ACCOUNT_ID) return json({ ...out, cloudflare: { configured: false } });
  try {
    const res = await fetchFn('https://api.cloudflare.com/client/v4/graphql', {
      method: 'POST',
      headers: { authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        query: USAGE_QUERY,
        variables: {
          account: env.CF_ACCOUNT_ID, db: env.D1_DATABASE_ID ?? '', script: env.WORKER_NAME ?? 'andata-ritorno-app', bucket: env.R2_BUCKET_NAME ?? 'andata-ritorno-photos',
          from, to, fromT: `${month}-01T00:00:00Z`, toT: now.toISOString(),
        },
      }),
    });
    const body = await res.json();
    if (!res.ok || body.errors?.length) throw new Error(body.errors?.map((e) => e.message).join('; ') || `graphql ${res.status}`);
    const acc = body.data?.viewer?.accounts?.[0] ?? {};
    const byDate = (rows, pick) => rows.map((r) => ({ day: r.dimensions.date, ...pick(r.sum) })).sort((a, b) => a.day.localeCompare(b.day));
    let classA = 0, classB = 0;
    for (const r of acc.r2ops ?? []) {
      if (R2_CLASS_A.has(r.dimensions.actionType)) classA += r.sum.requests;
      else if (R2_CLASS_B.has(r.dimensions.actionType)) classB += r.sum.requests;
    }
    const size = acc.r2size?.[0]?.max ?? {};
    out.cloudflare = {
      configured: true,
      d1: byDate(acc.d1 ?? [], (s) => ({ rowsRead: s.rowsRead, rowsWritten: s.rowsWritten, queries: s.readQueries + s.writeQueries })),
      worker: byDate(acc.worker ?? [], (s) => ({ requests: s.requests, errors: s.errors })),
      r2: { classAMonth: classA, classBMonth: classB, bytes: (size.payloadSize ?? 0) + (size.metadataSize ?? 0), objects: size.objectCount ?? 0 },
    };
  } catch (e) {
    out.cloudflare = { configured: true, error: String(e.message || e).slice(0, 300) };
  }
  return json(out);
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
  'GET /api/admin/usage': usage,
  'POST /api/admin/registrations': setRegistrations,
};
