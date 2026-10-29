import { HttpError, json, readBody } from './http.js';
import { requireApiDevice } from './auth.js';
import { ID } from './validate.js';

const MAX_PHOTO = 3 * 1024 * 1024;
const MAX_PHOTOS = 2000;

function checkPid(pid) {
  if (!ID.test(pid)) throw new HttpError(400, 'bad-request');
}

const USAGE = "key = 'photo_bytes'";
const DEFAULT_MAX_TOTAL = 9_000_000_000;

/** Global cap on stored photo bytes (all families), from the MAX_TOTAL_PHOTO_BYTES var. */
function totalCap(env) {
  const n = Number(env.MAX_TOTAL_PHOTO_BYTES);
  return env.MAX_TOTAL_PHOTO_BYTES != null && Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_MAX_TOTAL;
}

async function put(req, env, ctx, { pid }) {
  const { familyId } = await requireApiDevice(env, req);
  checkPid(pid);
  const body = await readBody(req, MAX_PHOTO, 'limit-photo-size');
  if (body.byteLength === 0) throw new HttpError(400, 'bad-request');
  // Replacing an existing photo does not grow the count.
  const row = await env.DB.prepare(
    'SELECT (SELECT COUNT(*) FROM photos WHERE family_id = ?1) AS n, (SELECT size FROM photos WHERE family_id = ?1 AND pid = ?2) AS old',
  )
    .bind(familyId, pid)
    .first();
  if (row.old == null && row.n >= MAX_PHOTOS) throw new HttpError(413, 'limit-photos');
  // Reserve the bytes in D1 first, in one batch: the total only moves when it stays within the cap
  // (the delta is computed inside the statement, so concurrent uploads cannot both pass), and the
  // row is written only if that happened. The R2 object is written afterwards, so a refusal never
  // leaves one behind.
  const size = body.byteLength;
  const delta = `(?1 - COALESCE((SELECT size FROM photos WHERE family_id = ?2 AND pid = ?3), 0))`;
  const results = await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO usage (key, bytes) VALUES ('photo_bytes', 0)`),
    env.DB.prepare(`UPDATE usage SET bytes = bytes + ${delta} WHERE ${USAGE} AND bytes + ${delta} <= ?4`).bind(size, familyId, pid, totalCap(env)),
    env.DB.prepare(
      `INSERT INTO photos (family_id, pid, size, uploaded_at) SELECT ?1, ?2, ?3, ?4 WHERE changes() = 1
       ON CONFLICT(family_id, pid) DO UPDATE SET size = excluded.size, uploaded_at = excluded.uploaded_at`,
    ).bind(familyId, pid, size, new Date().toISOString()),
  ]);
  if (results[1].meta.changes !== 1) throw new HttpError(413, 'limit-storage');
  try {
    await env.PHOTOS.put(`${familyId}/${pid}`, body);
  } catch (e) {
    // Undo the reservation (best effort) so a failed upload does not eat the budget.
    await env.DB.batch(
      row.old == null
        ? [
            env.DB.prepare(`UPDATE usage SET bytes = MAX(0, bytes - ?) WHERE ${USAGE}`).bind(size),
            env.DB.prepare('DELETE FROM photos WHERE family_id = ? AND pid = ?').bind(familyId, pid),
          ]
        : [
            env.DB.prepare(`UPDATE usage SET bytes = MAX(0, bytes - ? + ?) WHERE ${USAGE}`).bind(size, row.old),
            env.DB.prepare('UPDATE photos SET size = ? WHERE family_id = ? AND pid = ?').bind(row.old, familyId, pid),
          ],
    ).catch(() => {});
    throw e;
  }
  return new Response(null, { status: 204 });
}

async function get(req, env, ctx, { pid }) {
  const { familyId } = await requireApiDevice(env, req);
  checkPid(pid);
  const known = await env.DB.prepare('SELECT 1 FROM photos WHERE family_id = ? AND pid = ?').bind(familyId, pid).first();
  const obj = known && (await env.PHOTOS.get(`${familyId}/${pid}`));
  if (!obj) throw new HttpError(404, 'not-found');
  return new Response(obj.body, { headers: { 'content-type': 'application/octet-stream', 'cache-control': 'private, no-store' } });
}

async function list(req, env) {
  const { familyId } = await requireApiDevice(env, req);
  const { results } = await env.DB.prepare('SELECT pid, size, uploaded_at AS uploadedAt FROM photos WHERE family_id = ? ORDER BY uploaded_at, pid')
    .bind(familyId)
    .all();
  return json({ photos: results });
}

async function remove(req, env, ctx, { pid }) {
  const { familyId } = await requireApiDevice(env, req);
  checkPid(pid);
  await env.PHOTOS.delete(`${familyId}/${pid}`);
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE usage SET bytes = MAX(0, bytes - COALESCE((SELECT size FROM photos WHERE family_id = ? AND pid = ?), 0)) WHERE ${USAGE}`,
    ).bind(familyId, pid),
    env.DB.prepare('DELETE FROM photos WHERE family_id = ? AND pid = ?').bind(familyId, pid),
  ]);
  return new Response(null, { status: 204 });
}

export const photoRoutes = {
  'PUT /api/photos/:pid': put,
  'GET /api/photos/:pid': get,
  'GET /api/photos': list,
  'DELETE /api/photos/:pid': remove,
};
