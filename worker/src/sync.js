import { HttpError, json, readJson } from './http.js';
import { requireApiDevice } from './auth.js';
import { PULL_UNITS, requireBudget, spendDaily, spendNow } from './store.js';
import { ID } from './validate.js';

const PAGE = 500;
const MAX_PUSH = 200;
const MAX_RECORDS = 10000;
const MAX_DATA = 64 * 1024;
// Ciphertext bytes per family: a real wardrobe needs a few MB, this keeps one family from filling D1.
const MAX_FAMILY_DATA = 30 * 1024 * 1024;
const B64URL = /^[A-Za-z0-9_-]+$/;
// D1 allows at most 100 bound parameters per statement.
const IN_CHUNK = 50;

async function pull(req, env) {
  const { familyId, deviceId } = await requireApiDevice(env, req);
  const raw = new URL(req.url).searchParams.get('since') ?? '0';
  const since = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(since)) throw new HttpError(400, 'bad-request');
  // A full page reads PAGE rows: checked before reading and spent after, so pulling from 0 in a
  // loop runs out of budget. Everyday pulls return a few rows and cost nothing.
  await requireBudget(env.DB, deviceId, PULL_UNITS, familyId);
  const { results } = await env.DB.prepare('SELECT rid, seq, data FROM records WHERE family_id = ? AND seq > ? ORDER BY seq LIMIT ?')
    .bind(familyId, since, PAGE)
    .all();
  if (results.length === PAGE) await spendNow(env.DB, deviceId, PULL_UNITS, familyId).catch(() => {});
  return json({ records: results, next: results.length ? results[results.length - 1].seq : since, more: results.length === PAGE });
}

/** How many of `rids` the family already has, and their current ciphertext length. */
async function existing(env, familyId, rids) {
  let n = 0;
  let bytes = 0;
  for (let i = 0; i < rids.length; i += IN_CHUNK) {
    const part = rids.slice(i, i + IN_CHUNK);
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(length(data)), 0) AS b FROM records WHERE family_id = ? AND rid IN (${part.map(() => '?').join(',')})`,
    )
      .bind(familyId, ...part)
      .first();
    n += row.n;
    bytes += row.b;
  }
  return { n, bytes };
}

async function push(req, env) {
  const { familyId, deviceId } = await requireApiDevice(env, req);
  const body = await readJson(req, MAX_PUSH * (MAX_DATA + 128));
  const records = body?.records;
  if (!Array.isArray(records)) throw new HttpError(400, 'bad-request');
  if (records.length > MAX_PUSH) throw new HttpError(413, 'limit-records');
  for (const r of records) {
    if (!r || typeof r.rid !== 'string' || !ID.test(r.rid) || typeof r.data !== 'string' || !B64URL.test(r.data)) throw new HttpError(400, 'bad-request');
    if (r.data.length > MAX_DATA) throw new HttpError(413, 'limit-record-size');
  }
  const n = records.length;
  if (n === 0) {
    const row = await env.DB.prepare('SELECT seq FROM families WHERE id = ?').bind(familyId).first();
    if (!row) throw new HttpError(401, 'unauthorized');
    return json({ seq: row.seq });
  }
  // The family's size lives in counters on its row (records_n, data_bytes), so a push reads only the
  // rids it sends instead of scanning the whole family. The record that ends up stored for a rid
  // is the last one sent for it.
  // shortcut: two concurrent pushes of the same rid both see the same old row, so the counters can
  // drift by that record; harmless next to the caps. Recount from records if it ever matters.
  const last = new Map(records.map((r) => [r.rid, r.data.length]));
  const before = await existing(env, familyId, [...last.keys()]);
  const added = last.size - before.n;
  const grow = [...last.values()].reduce((a, b) => a + b, 0) - before.bytes;

  // One transaction: spend the device's and the family's daily budget, then reserve n sequence
  // numbers only if the family stays within its caps, then give record i the number base + i. Each
  // statement runs only if the one before it changed a row, so a refused reservation writes nothing.
  const results = await env.DB.batch([
    ...spendDaily(env.DB, deviceId, n, familyId),
    env.DB.prepare(
      `UPDATE families SET seq = seq + ?1, records_n = records_n + ?3, data_bytes = data_bytes + ?5
       WHERE id = ?2 AND changes() = 1 AND (?3 <= 0 OR records_n + ?3 <= ?4) AND (?5 <= 0 OR data_bytes + ?5 <= ?6) RETURNING seq`,
    ).bind(n, familyId, added, MAX_RECORDS, grow, MAX_FAMILY_DATA),
    ...records.map((r, i) =>
      env.DB.prepare(
        `INSERT INTO records (family_id, rid, seq, data) SELECT ?, ?, (SELECT seq FROM families WHERE id = ?) - ? + ?, ? WHERE changes() = 1
         ON CONFLICT(family_id, rid) DO UPDATE SET data = excluded.data, seq = excluded.seq`,
      ).bind(familyId, r.rid, familyId, n, i + 1, r.data),
    ),
  ]);
  if (results[1].meta.changes !== 1) throw new HttpError(429, 'limit-daily');
  if (results[2].meta.changes !== 1) throw new HttpError(413, 'limit-records');
  return json({ seq: results[2].results[0].seq });
}

export const syncRoutes = {
  'GET /api/sync': pull,
  'POST /api/sync': push,
};
