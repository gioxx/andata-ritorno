import { HttpError, clientIp, json, limited, readJson } from './http.js';

// Public, heavily aggregated numbers for the landing site (issue #4). Every figure is rounded down
// to a multiple of ten and hidden below ten, so the arrival or departure of a single family cannot
// be read from a change in the totals. The answer is cached for a few hours.
//
// Anonymous use without a family (issue #35): at most once a week each app sends a ping with three
// coarse values and nothing else. The server adds one to a counter per (ISO week, metric, bucket):
// no identifier, no timestamp beyond the week, the IP only for the rate limit and never stored. The
// counters cannot tell one phone from another; they say how many phones used A/R that week.

const CACHE_SECONDS = 6 * 60 * 60;
const MIN_SHOWN = 10;
const MIN_FAMILIES = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

/** @returns {number|null} n rounded down to ten, or null when too small to show. */
export function coarse(n) {
  const v = Number(n) || 0;
  return v < MIN_SHOWN ? null : Math.floor(v / 10) * 10;
}

/** Coarse buckets, the only values a ping may carry (anything else is refused). */
export const PING_BUCKETS = Object.freeze({
  items: ['0', '1-5', '6-20', '21+'],
  moves: ['0', '1-5', '6-20', '21+'],
});
const VERSION_RE = /^\d{1,3}\.\d{1,3}$/;

/** ISO 8601 week of a date, as '2026-W45' (weeks start on Monday; week 1 holds the first Thursday). */
export function isoWeek(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const year = d.getUTCFullYear();
  const week = Math.ceil(((d - Date.UTC(year, 0, 1)) / DAY_MS + 1) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/** Exactly { v, items, moves } with allowed values, or null. Extra fields are refused, not dropped. */
export function validPing(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const keys = Object.keys(body).sort().join(',');
  if (keys !== 'items,moves,v') return null;
  if (typeof body.v !== 'string' || !VERSION_RE.test(body.v)) return null;
  if (!PING_BUCKETS.items.includes(body.items) || !PING_BUCKETS.moves.includes(body.moves)) return null;
  return { v: body.v, items: body.items, moves: body.moves };
}

async function ping(req, env) {
  // Its own bucket on the tight limiter: a few pings a minute per address are plenty for a home.
  if (await limited(env.RL_STRICT, `ping:${clientIp(req)}`)) throw new HttpError(429, 'rate-limited');
  const p = validPing(await readJson(req, 256));
  if (!p) throw new HttpError(400, 'bad-request');
  const week = isoWeek(new Date());
  const add = env.DB.prepare('INSERT INTO usage_weekly (week, metric, bucket, n) VALUES (?, ?, ?, 1) ON CONFLICT (week, metric, bucket) DO UPDATE SET n = n + 1');
  await env.DB.batch([
    add.bind(week, 'phones', 'all'),
    add.bind(week, 'version', p.v),
    add.bind(week, 'items', p.items),
    add.bind(week, 'moves', p.moves),
  ]);
  return new Response(null, { status: 204 });
}

async function compute(env) {
  const since = new Date(Date.now() - 30 * DAY_MS).toISOString();
  // The last whole week: the current one is still filling up.
  const lastWeek = isoWeek(new Date(Date.now() - 7 * DAY_MS));
  const [families, phones, active, records, photos, local] = await env.DB.batch([
    env.DB.prepare('SELECT COUNT(*) AS n FROM families'),
    env.DB.prepare('SELECT COUNT(*) AS n FROM devices'),
    env.DB.prepare('SELECT COUNT(*) AS n FROM devices WHERE last_seen_at >= ?').bind(since),
    env.DB.prepare('SELECT COUNT(*) AS n FROM records'),
    env.DB.prepare('SELECT COUNT(*) AS n FROM photos WHERE ready = 1'),
    env.DB.prepare("SELECT n FROM usage_weekly WHERE week = ? AND metric = 'phones' AND bucket = 'all'").bind(lastWeek),
  ]);
  const n = (r) => r.results[0]?.n ?? 0;
  // With only a handful of families, any total describes those families: show nothing until there
  // are enough of them to hide in.
  const crowd = n(families) >= MIN_FAMILIES;
  const shown = (v) => (crowd ? coarse(v) : null);
  return {
    families: shown(n(families)),
    phones: shown(n(phones)),
    activePhones30d: shown(n(active)),
    syncedRecords: shown(n(records)),
    photos: shown(n(photos)),
    // Phones used without a family last week, from the anonymous pings. A different kind of number
    // (only those who left the statistics on), never added to the totals above.
    localPhonesLastWeek: coarse(n(local)),
    // The day, not the time: the cache refreshes a few times a day.
    asOf: new Date().toISOString().slice(0, 10),
  };
}

async function stats(req, env, ctx) {
  const cache = globalThis.caches?.default;
  // Versioned key: a change to what is shown must not wait for old cached answers to expire.
  const key = new Request(new URL('/api/public/stats?v=3', req.url).href);
  const hit = await cache?.match(key);
  if (hit) return hit;
  const res = json(await compute(env));
  res.headers.set('cache-control', `public, max-age=${CACHE_SECONDS}`);
  if (cache) {
    const put = cache.put(key, res.clone());
    if (ctx?.waitUntil) ctx.waitUntil(put);
    else await put;
  }
  return res;
}

export const publicRoutes = {
  'GET /api/public/stats': stats,
  'POST /api/public/ping': ping,
};
