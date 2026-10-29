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
    'SELECT (SELECT COUNT(*) FROM photos WHERE family_id = ?1) AS n, EXISTS (SELECT 1 FROM photos WHERE family_id = ?1 AND pid = ?2) AS known',
  )
    .bind(familyId, pid)
    .first();
  if (!row.known && row.n >= MAX_PHOTOS) throw new HttpError(413, 'limit-photos');
  // Reserve the bytes in D1 first, in one batch: the total only moves when it stays within the cap
  // (the delta is computed inside the statement, so concurrent uploads cannot both pass; a photo
  // that does not grow the total always fits), and the row is written only if that happened. The
  // row starts as not ready (invisible to list and get) and turns ready once the R2 object is
  // written, so an interrupted upload is re-sent by the next sync instead of leaving a dangling row.
  // The R2 write comes after the reservation, so a refusal never leaves an object behind.
  const size = body.byteLength;
  const token = new Date().toISOString(); // this request's uploaded_at: marks the row as its own
  const delta = '(?1 - COALESCE((SELECT size FROM photos WHERE family_id = ?2 AND pid = ?3), 0))';
  const results = await env.DB.batch([
    env.DB.prepare('SELECT size, uploaded_at FROM photos WHERE family_id = ? AND pid = ?').bind(familyId, pid),
    env.DB.prepare("INSERT OR IGNORE INTO usage (key, bytes) SELECT 'photo_bytes', COALESCE(SUM(size), 0) FROM photos"),
    env.DB.prepare(`UPDATE usage SET bytes = bytes + ${delta} WHERE ${USAGE} AND (${delta} <= 0 OR bytes + ${delta} <= ?4)`).bind(
      size,
      familyId,
      pid,
      totalCap(env),
    ),
    env.DB.prepare(
      `INSERT INTO photos (family_id, pid, size, uploaded_at, ready) SELECT ?1, ?2, ?3, ?4, 0 WHERE changes() = 1
       ON CONFLICT(family_id, pid) DO UPDATE SET size = excluded.size, uploaded_at = excluded.uploaded_at`,
    ).bind(familyId, pid, size, token),
  ]);
  if (results[2].meta.changes !== 1) throw new HttpError(413, 'limit-storage');
  const old = results[0].results[0] ?? null;
  // The statements below only touch the row while it is still this request's own.
  const mine = 'EXISTS (SELECT 1 FROM photos WHERE family_id = ?1 AND pid = ?2 AND uploaded_at = ?3 AND size = ?4)';
  try {
    await env.PHOTOS.put(`${familyId}/${pid}`, body);
  } catch (e) {
    // Give the reservation back so a failed upload does not eat the budget; the previous object
    // (if any) was not touched.
    try {
      await env.DB.batch(
        old == null
          ? [
              env.DB.prepare(`UPDATE usage SET bytes = MAX(0, bytes - ?4) WHERE ${USAGE} AND ${mine}`).bind(familyId, pid, token, size),
              env.DB.prepare('DELETE FROM photos WHERE family_id = ?1 AND pid = ?2 AND uploaded_at = ?3 AND size = ?4').bind(familyId, pid, token, size),
            ]
          : [
              env.DB.prepare(`UPDATE usage SET bytes = MAX(0, bytes - ?4 + ?5) WHERE ${USAGE} AND ${mine}`).bind(familyId, pid, token, size, old.size),
              env.DB.prepare('UPDATE photos SET size = ?5, uploaded_at = ?6 WHERE family_id = ?1 AND pid = ?2 AND uploaded_at = ?3 AND size = ?4').bind(
                familyId,
                pid,
                token,
                size,
                old.size,
                old.uploaded_at,
              ),
            ],
      );
    } catch (undoError) {
      console.error('photo reservation undo failed', familyId, pid, undoError);
    }
    throw e;
  }
  await env.DB.prepare('UPDATE photos SET ready = 1 WHERE family_id = ? AND pid = ? AND uploaded_at = ?').bind(familyId, pid, token).run();
  return new Response(null, { status: 204 });
}

async function get(req, env, ctx, { pid }) {
  const { familyId } = await requireApiDevice(env, req);
  checkPid(pid);
  const known = await env.DB.prepare('SELECT 1 FROM photos WHERE family_id = ? AND pid = ? AND ready = 1').bind(familyId, pid).first();
  const obj = known && (await env.PHOTOS.get(`${familyId}/${pid}`));
  if (!obj) throw new HttpError(404, 'not-found');
  return new Response(obj.body, { headers: { 'content-type': 'application/octet-stream', 'cache-control': 'private, no-store' } });
}

async function list(req, env) {
  const { familyId } = await requireApiDevice(env, req);
  const { results } = await env.DB.prepare('SELECT pid, size, uploaded_at AS uploadedAt FROM photos WHERE family_id = ? AND ready = 1 ORDER BY uploaded_at, pid')
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
