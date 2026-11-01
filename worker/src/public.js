import { json } from './http.js';

// Public, heavily aggregated numbers for the landing site (issue #4). Only totals that already exist
// in the database: nothing new is collected, free local-only use stays invisible. Every figure is
// rounded down to a multiple of ten and hidden below ten, so the arrival or departure of a single
// family cannot be read from a change in the totals. The answer is cached for a few hours.

const CACHE_SECONDS = 6 * 60 * 60;
const MIN_SHOWN = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

/** @returns {number|null} n rounded down to ten, or null when too small to show. */
export function coarse(n) {
  const v = Number(n) || 0;
  return v < MIN_SHOWN ? null : Math.floor(v / 10) * 10;
}

async function compute(env) {
  const since = new Date(Date.now() - 30 * DAY_MS).toISOString();
  const [families, phones, active, records, photos] = await env.DB.batch([
    env.DB.prepare('SELECT COUNT(*) AS n FROM families'),
    env.DB.prepare('SELECT COUNT(*) AS n FROM devices'),
    env.DB.prepare('SELECT COUNT(*) AS n FROM devices WHERE last_seen_at >= ?').bind(since),
    env.DB.prepare('SELECT COUNT(*) AS n FROM records'),
    env.DB.prepare('SELECT COUNT(*) AS n FROM photos WHERE ready = 1'),
  ]);
  const n = (r) => r.results[0]?.n ?? 0;
  return {
    families: coarse(n(families)),
    phones: coarse(n(phones)),
    activePhones30d: coarse(n(active)),
    syncedRecords: coarse(n(records)),
    photos: coarse(n(photos)),
    // The day, not the time: the cache refreshes a few times a day.
    asOf: new Date().toISOString().slice(0, 10),
  };
}

async function stats(req, env, ctx) {
  const cache = globalThis.caches?.default;
  const key = new Request(new URL('/api/public/stats', req.url).href);
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
};
