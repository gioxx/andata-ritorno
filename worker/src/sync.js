import { HttpError, json, readJson } from './http.js';
import { requireApiDevice } from './auth.js';
import { ID } from './validate.js';

const PAGE = 500;
const MAX_PUSH = 200;
const MAX_RECORDS = 10000;
const MAX_DATA = 64 * 1024;
const B64URL = /^[A-Za-z0-9_-]+$/;
// D1 allows at most 100 bound parameters per statement.
const IN_CHUNK = 50;

async function pull(req, env) {
  const { familyId } = await requireApiDevice(env, req);
  const raw = new URL(req.url).searchParams.get('since') ?? '0';
  const since = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(since)) throw new HttpError(400, 'bad-request');
  const { results } = await env.DB.prepare('SELECT rid, seq, data FROM records WHERE family_id = ? AND seq > ? ORDER BY seq LIMIT ?')
    .bind(familyId, since, PAGE)
    .all();
  return json({ records: results, next: results.length ? results[results.length - 1].seq : since, more: results.length === PAGE });
}

async function countExisting(env, familyId, rids) {
  let n = 0;
  for (let i = 0; i < rids.length; i += IN_CHUNK) {
    const part = rids.slice(i, i + IN_CHUNK);
    const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM records WHERE family_id = ? AND rid IN (${part.map(() => '?').join(',')})`)
      .bind(familyId, ...part)
      .first();
    n += row.n;
  }
  return n;
}

async function push(req, env) {
  const { familyId } = await requireApiDevice(env, req);
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
    return json({ seq: row.seq });
  }
  // Updates of existing rids do not grow the family, so only new distinct rids count toward the cap.
  const rids = [...new Set(records.map((r) => r.rid))];
  const total = (await env.DB.prepare('SELECT COUNT(*) AS n FROM records WHERE family_id = ?').bind(familyId).first()).n;
  if (total + rids.length - (await countExisting(env, familyId, rids)) > MAX_RECORDS) throw new HttpError(413, 'limit-records');

  // One transaction: reserve n sequence numbers, then give record i the number base + i.
  const results = await env.DB.batch([
    env.DB.prepare('UPDATE families SET seq = seq + ? WHERE id = ? RETURNING seq').bind(n, familyId),
    ...records.map((r, i) =>
      env.DB.prepare(
        `INSERT INTO records (family_id, rid, seq, data) VALUES (?, ?, (SELECT seq FROM families WHERE id = ?) - ? + ?, ?)
         ON CONFLICT(family_id, rid) DO UPDATE SET data = excluded.data, seq = excluded.seq`,
      ).bind(familyId, r.rid, familyId, n, i + 1, r.data),
    ),
  ]);
  return json({ seq: results[0].results[0].seq });
}

export const syncRoutes = {
  'GET /api/sync': pull,
  'POST /api/sync': push,
};
