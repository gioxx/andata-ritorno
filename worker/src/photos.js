import { HttpError, json, readBody } from './http.js';
import { randomToken, requireApiDevice } from './auth.js';
import { PHOTO_UNITS, spendDaily } from './store.js';
import { ID } from './validate.js';

const MAX_PHOTO = 3 * 1024 * 1024;
// Photos per family: far above one wardrobe (a photo per item), well below what R2 can hold for all.
const MAX_PHOTOS = 500;
// Photo bytes per family: about twice 500 photos at the app's usual size (1600 px WebP, 200-300 KB),
// so one family cannot take a large share of the global cap.
const MAX_FAMILY_PHOTO_BYTES = 300_000_000;

function checkPid(pid) {
  if (!ID.test(pid)) throw new HttpError(400, 'bad-request');
}

const USAGE = "key = 'photo_bytes'";
// A reservation not ready after this long was abandoned (the Worker stopped mid-upload): it is
// reclaimed so it stops counting toward the caps. A phone that still has the photo uploads it again.
const STALE_MS = 60 * 60 * 1000;
const DEFAULT_MAX_TOTAL = 9_000_000_000;

/**
 * The R2 key of one upload of a photo. Each upload writes under its own token, so cleaning up an
 * abandoned or replaced upload never touches another upload's object. Rows written before per-upload
 * keys (a plain time, no '~') keep the bare key.
 */
const objectKey = (familyId, pid, uploadedAt) => (uploadedAt.includes('~') ? `${familyId}/${pid}/${uploadedAt}` : `${familyId}/${pid}`);

/**
 * Delete this photo's objects from uploads older than `token` (or up to it, `inclusive`), plus the
 * bare key of before. Newer uploads may still be in flight: theirs are kept.
 */
async function dropUploads(env, familyId, pid, token, { inclusive = false } = {}) {
  const prefix = `${familyId}/${pid}/`;
  const keys = [`${familyId}/${pid}`];
  let cursor;
  do {
    const page = await env.PHOTOS.list({ prefix, cursor });
    for (const o of page.objects) {
      const t = o.key.slice(prefix.length);
      if (inclusive ? t <= token : t < token) keys.push(o.key);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  await env.PHOTOS.delete(keys);
}

/** Global cap on stored photo bytes (all families), from the MAX_TOTAL_PHOTO_BYTES var. */
function totalCap(env) {
  const n = Number(env.MAX_TOTAL_PHOTO_BYTES);
  return env.MAX_TOTAL_PHOTO_BYTES != null && Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_MAX_TOTAL;
}

async function put(req, env, ctx, { pid }) {
  const { familyId, deviceId } = await requireApiDevice(env, req);
  checkPid(pid);
  const body = await readBody(req, MAX_PHOTO, 'limit-photo-size');
  if (body.byteLength === 0) throw new HttpError(400, 'bad-request');
  // Reserve the bytes in D1 first, in one batch: the total only moves when it stays within the cap
  // and a new photo still fits the family's count (both computed inside the statement, so
  // concurrent uploads cannot both pass; replacing a photo never grows the count, and one that
  // does not grow the total always fits), and the row is written only if that happened. The
  // row starts as not ready (invisible to list and get) and turns ready once the R2 object is
  // written, so an interrupted upload is re-sent by the next sync instead of leaving a dangling row.
  // The R2 write comes after the reservation, so a refusal never leaves an object behind.
  const size = body.byteLength;
  // This request's uploaded_at, which marks the row (and the object key) as its own: the time plus a
  // nonce, so two uploads of the same photo in the same millisecond never take each other's for
  // their own. Listing shows the time part only (the first 24 characters).
  const token = `${new Date().toISOString()}~${randomToken()}`;
  const key = objectKey(familyId, pid, token);
  const delta = '(?1 - COALESCE((SELECT size FROM photos WHERE family_id = ?2 AND pid = ?3), 0))';
  // The family must still exist: one purged while this body was arriving takes no new photos.
  // It must also fit the family's photo count and its share of bytes.
  const fits = `(EXISTS (SELECT 1 FROM families WHERE id = ?2)
    AND (EXISTS (SELECT 1 FROM photos WHERE family_id = ?2 AND pid = ?3) OR (SELECT COUNT(*) FROM photos WHERE family_id = ?2) < ?5)
    AND (SELECT COALESCE(SUM(size), 0) FROM photos WHERE family_id = ?2) + ${delta} <= ?6)`;
  const results = await env.DB.batch([
    env.DB.prepare('SELECT size, uploaded_at FROM photos WHERE family_id = ? AND pid = ?').bind(familyId, pid),
    // Which limit refused it, if one did (same snapshot as the reservation below).
    env.DB.prepare(
      `SELECT EXISTS (SELECT 1 FROM families WHERE id = ?2) AS family,
         (EXISTS (SELECT 1 FROM photos WHERE family_id = ?2 AND pid = ?3) OR (SELECT COUNT(*) FROM photos WHERE family_id = ?2) < ?5)
         AND (SELECT COALESCE(SUM(size), 0) FROM photos WHERE family_id = ?2) + ${delta} <= ?6 AS ok`,
    ).bind(size, familyId, pid, null, MAX_PHOTOS, MAX_FAMILY_PHOTO_BYTES),
    env.DB.prepare("INSERT OR IGNORE INTO usage (key, bytes) SELECT 'photo_bytes', COALESCE(SUM(size), 0) FROM photos"),
    // The device's daily budget comes first: the reservation below runs only if it was spent.
    spendDaily(env.DB, deviceId, PHOTO_UNITS),
    env.DB.prepare(`UPDATE usage SET bytes = bytes + ${delta} WHERE ${USAGE} AND changes() = 1 AND ${fits} AND (${delta} <= 0 OR bytes + ${delta} <= ?4)`).bind(
      size,
      familyId,
      pid,
      totalCap(env),
      MAX_PHOTOS,
      MAX_FAMILY_PHOTO_BYTES,
    ),
    env.DB.prepare(
      `INSERT INTO photos (family_id, pid, size, uploaded_at, ready) SELECT ?1, ?2, ?3, ?4, 0 WHERE changes() = 1
       ON CONFLICT(family_id, pid) DO UPDATE SET size = excluded.size, uploaded_at = excluded.uploaded_at`,
    ).bind(familyId, pid, size, token),
  ]);
  if (results[3].meta.changes !== 1) throw new HttpError(429, 'limit-daily');
  if (results[4].meta.changes !== 1) {
    const why = results[1].results[0];
    if (!why.family) throw new HttpError(401, 'unauthorized');
    throw new HttpError(413, why.ok ? 'limit-storage' : 'limit-photos');
  }
  const old = results[0].results[0] ?? null;
  // The statements below only touch the row while it is still this request's own.
  const mine = 'EXISTS (SELECT 1 FROM photos WHERE family_id = ?1 AND pid = ?2 AND uploaded_at = ?3 AND size = ?4)';
  try {
    await env.PHOTOS.put(key, body);
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
  const done = await env.DB.batch([
    env.DB.prepare('UPDATE photos SET ready = 1 WHERE family_id = ? AND pid = ? AND uploaded_at = ?').bind(familyId, pid, token),
    env.DB.prepare('SELECT 1 FROM families WHERE id = ?').bind(familyId),
  ]);
  if (done[0].meta.changes === 1) {
    // This upload is the photo now: the objects of earlier ones are nobody's.
    try {
      await dropUploads(env, familyId, pid, token);
    } catch (e) {
      console.error('photo cleanup failed', familyId, pid, e);
    }
    return new Response(null, { status: 204 });
  }
  // The row is no longer this upload's: a newer upload took it, the photo was deleted, or the family
  // was purged meanwhile (its prefix already swept). This object is nobody's either way.
  await env.PHOTOS.delete(key);
  if (!done[1].results.length) throw new HttpError(401, 'unauthorized');
  return new Response(null, { status: 204 });
}

async function get(req, env, ctx, { pid }) {
  const { familyId } = await requireApiDevice(env, req);
  checkPid(pid);
  const row = await env.DB.prepare('SELECT uploaded_at FROM photos WHERE family_id = ? AND pid = ? AND ready = 1').bind(familyId, pid).first();
  const obj = row && (await env.PHOTOS.get(objectKey(familyId, pid, row.uploaded_at)));
  if (!obj) throw new HttpError(404, 'not-found');
  return new Response(obj.body, { headers: { 'content-type': 'application/octet-stream', 'cache-control': 'private, no-store' } });
}

/** Drop this family's abandoned reservations: their rows, their bytes in the total, their objects. */
async function reclaimStale(env, familyId) {
  const before = new Date(Date.now() - STALE_MS).toISOString();
  const stale = 'family_id = ?1 AND ready = 0 AND uploaded_at < ?2';
  const { results: rows } = await env.DB.prepare(`SELECT pid, uploaded_at FROM photos WHERE ${stale}`).bind(familyId, before).all();
  if (!rows.length) return;
  await env.DB.batch([
    env.DB.prepare(`UPDATE usage SET bytes = MAX(0, bytes - (SELECT COALESCE(SUM(size), 0) FROM photos WHERE ${stale})) WHERE ${USAGE}`).bind(
      familyId,
      before,
    ),
    env.DB.prepare(`DELETE FROM photos WHERE ${stale}`).bind(familyId, before),
  ]);
  // Up to the abandoned upload only: a retry of the same photo has a newer key and may be in flight.
  for (const r of rows) await dropUploads(env, familyId, r.pid, r.uploaded_at, { inclusive: true });
}

async function list(req, env) {
  const { familyId } = await requireApiDevice(env, req);
  // Every sync lists the photos first, so a family's abandoned uploads never outlive its phones' use.
  await reclaimStale(env, familyId);
  const { results } = await env.DB.prepare('SELECT pid, size, substr(uploaded_at, 1, 24) AS uploadedAt FROM photos WHERE family_id = ? AND ready = 1 ORDER BY uploaded_at, pid')
    .bind(familyId)
    .all();
  return json({ photos: results });
}

async function remove(req, env, ctx, { pid }) {
  const { familyId } = await requireApiDevice(env, req);
  checkPid(pid);
  await dropUploads(env, familyId, pid, '\uffff', { inclusive: true });
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
