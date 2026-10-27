import { HttpError, json } from './http.js';
import { requireApiDevice } from './auth.js';
import { ID } from './validate.js';

const MAX_PHOTO = 3 * 1024 * 1024;
const MAX_PHOTOS = 2000;

function checkPid(pid) {
  if (!ID.test(pid)) throw new HttpError(400, 'bad-request');
}

async function put(req, env, ctx, { pid }) {
  const { familyId } = await requireApiDevice(env, req);
  checkPid(pid);
  if (Number(req.headers.get('content-length')) > MAX_PHOTO) throw new HttpError(413, 'limit-photo-size');
  const body = await req.arrayBuffer();
  if (body.byteLength > MAX_PHOTO) throw new HttpError(413, 'limit-photo-size');
  if (body.byteLength === 0) throw new HttpError(400, 'bad-request');
  // Replacing an existing photo does not grow the count.
  const row = await env.DB.prepare(
    'SELECT (SELECT COUNT(*) FROM photos WHERE family_id = ?1) AS n, EXISTS (SELECT 1 FROM photos WHERE family_id = ?1 AND pid = ?2) AS known',
  )
    .bind(familyId, pid)
    .first();
  if (!row.known && row.n >= MAX_PHOTOS) throw new HttpError(413, 'limit-photos');
  await env.PHOTOS.put(`${familyId}/${pid}`, body);
  await env.DB.prepare(
    `INSERT INTO photos (family_id, pid, size, uploaded_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(family_id, pid) DO UPDATE SET size = excluded.size, uploaded_at = excluded.uploaded_at`,
  )
    .bind(familyId, pid, body.byteLength, new Date().toISOString())
    .run();
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
  await env.DB.prepare('DELETE FROM photos WHERE family_id = ? AND pid = ?').bind(familyId, pid).run();
  return new Response(null, { status: 204 });
}

export const photoRoutes = {
  'PUT /api/photos/:pid': put,
  'GET /api/photos/:pid': get,
  'GET /api/photos': list,
  'DELETE /api/photos/:pid': remove,
};
