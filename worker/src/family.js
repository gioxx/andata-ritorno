import { HttpError, json, readJson, strictLimit } from './http.js';
import { randomToken, requireDevice, sha256Hex } from './auth.js';
import { deviceLimit, purgePhotos, purgeStatements } from './store.js';
import { ENC, ID, isSecret } from './validate.js';

const INVITE_TTL_MS = 10 * 60 * 1000;

// SQL fragments over a family `f` joined to its licence `l`.
const LIMIT = 'l.base_limit + l.extra_slots';
const USED = '(SELECT COUNT(*) FROM devices d WHERE d.family_id = f.id)';

const nowIso = () => new Date().toISOString();

function inviteExpired() {
  throw new HttpError(410, 'invite-expired');
}

function badKit() {
  throw new HttpError(403, 'bad-kit');
}

async function devicesOf(env, familyId) {
  const { results } = await env.DB.prepare(
    'SELECT id, name_enc AS nameEnc, created_at AS createdAt, last_seen_at AS lastSeenAt FROM devices WHERE family_id = ? ORDER BY created_at, id',
  )
    .bind(familyId)
    .all();
  return results;
}

/** Give an existing device of the family a fresh token (its old one stops working). */
async function newTokenFor(env, familyId, deviceId, guard = '1', guardArgs = []) {
  const token = randomToken();
  const { meta } = await env.DB.prepare(`UPDATE devices SET token_hash = ?, last_seen_at = ? WHERE id = ? AND family_id = ? AND ${guard}`)
    .bind(await sha256Hex(token), nowIso(), deviceId, familyId, ...guardArgs)
    .run();
  return meta.changes === 1 ? token : null;
}

async function family(req, env) {
  const { deviceId, familyId } = await requireDevice(env, req);
  const row = await env.DB.prepare(`SELECT f.name_enc, ${LIMIT} AS lim FROM families f JOIN licences l ON l.id = f.licence_id WHERE f.id = ?`)
    .bind(familyId)
    .first();
  return json({ familyId, familyNameEnc: row.name_enc, deviceLimit: row.lim, you: deviceId, devices: await devicesOf(env, familyId) });
}

async function createInvite(req, env) {
  const { familyId } = await requireDevice(env, req);
  const row = await env.DB.prepare(`SELECT ${USED} AS used, ${LIMIT} AS lim FROM families f JOIN licences l ON l.id = f.licence_id WHERE f.id = ?`)
    .bind(familyId)
    .first();
  if (row.used >= row.lim) throw new HttpError(409, 'family-full');
  const token = randomToken();
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString();
  await env.DB.prepare('INSERT INTO invites (hash, family_id, expires_at) VALUES (?, ?, ?)').bind(await sha256Hex(token), familyId, expiresAt).run();
  return json({ token, expiresAt, used: row.used, limit: row.lim });
}

async function inviteInfo(req, env) {
  await strictLimit(env, req);
  const t = new URL(req.url).searchParams.get('t');
  if (!isSecret(t)) inviteExpired();
  const row = await env.DB.prepare(
    `SELECT f.name_enc, ${USED} AS used, ${LIMIT} AS lim FROM invites i JOIN families f ON f.id = i.family_id JOIN licences l ON l.id = f.licence_id
     WHERE i.hash = ? AND i.used_at IS NULL AND i.expires_at > ?`,
  )
    .bind(await sha256Hex(t), nowIso())
    .first();
  if (!row) inviteExpired();
  return json({ familyNameEnc: row.name_enc, used: row.used, limit: row.lim });
}

async function join(req, env) {
  await strictLimit(env, req);
  const { inviteToken, deviceId, deviceNameEnc } = (await readJson(req)) ?? {};
  if (!ID.test(deviceId ?? '') || !ENC.test(deviceNameEnc ?? '')) throw new HttpError(400, 'bad-request');
  if (!isSecret(inviteToken)) inviteExpired();
  const hash = await sha256Hex(inviteToken);
  const at = nowIso();
  const inv = await env.DB.prepare('SELECT family_id, expires_at, used_at FROM invites WHERE hash = ?').bind(hash).first();
  if (!inv || inv.expires_at <= at) inviteExpired();
  if (inv.used_at) return replayJoin(env, inv, deviceId);

  const token = randomToken();
  const tokenHash = await sha256Hex(token);
  // One transaction: the device goes in only while the invite is open and the family has room, so
  // concurrent joins cannot exceed the limit; the invite is then marked used by the device's own
  // created_at, which also lets a retry of this request be recognised (replayJoin).
  const results = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO devices (id, family_id, token_hash, name_enc, created_at, last_seen_at)
       SELECT ?, f.id, ?, ?, ?, ? FROM invites i JOIN families f ON f.id = i.family_id JOIN licences l ON l.id = f.licence_id
       WHERE i.hash = ? AND i.used_at IS NULL AND i.expires_at > ? AND ${USED} < ${LIMIT}`,
    ).bind(deviceId, tokenHash, deviceNameEnc, at, at, hash, at),
    env.DB.prepare('UPDATE invites SET used_at = ? WHERE hash = ? AND EXISTS (SELECT 1 FROM devices WHERE token_hash = ?)').bind(at, hash, tokenHash),
  ]);
  if (results[0].meta.changes !== 1) {
    const latest = await env.DB.prepare('SELECT family_id, expires_at, used_at FROM invites WHERE hash = ?').bind(hash).first();
    if (!latest || latest.expires_at <= at) inviteExpired();
    if (latest.used_at) return replayJoin(env, latest, deviceId);
    throw new HttpError(409, 'family-full');
  }
  return json({ token, deviceLimit: await deviceLimit(env, await licenceOf(env, inv.family_id)) });
}

/**
 * A used invite still inside its TTL, retried by the device that used it (its response was lost):
 * that device, created at the moment the invite was used, gets a fresh token. Anything else → 410.
 */
async function replayJoin(env, inv, deviceId) {
  const token = await newTokenFor(env, inv.family_id, deviceId, 'created_at = ?', [inv.used_at]);
  if (!token) inviteExpired();
  return json({ token, deviceLimit: await deviceLimit(env, await licenceOf(env, inv.family_id)) });
}

async function licenceOf(env, familyId) {
  return (await env.DB.prepare('SELECT licence_id FROM families WHERE id = ?').bind(familyId).first()).licence_id;
}

async function removeDevice(req, env, ctx, params) {
  const { familyId } = await requireDevice(env, req);
  // Removing the family's last device (only possible as a self-removal, i.e. leaving) purges it in
  // the same transaction; the licence stays, detached, for a later restart.
  const results = await env.DB.batch([
    env.DB.prepare('DELETE FROM devices WHERE id = ? AND family_id = ?').bind(params.id, familyId),
    ...purgeStatements(env.DB, familyId, 'NOT EXISTS (SELECT 1 FROM devices WHERE family_id = ?)', [familyId]),
  ]);
  if (results[0].meta.changes !== 1) throw new HttpError(404, 'not-found');
  const purged = results.at(-1).meta.changes === 1;
  if (purged) await purgePhotos(env, familyId);
  return json({ purged });
}

/**
 * Check a recovery kit. A wrong secret and an unknown family both give 403 bad-kit, so the answer
 * never tells whether a family id exists.
 * @returns {Promise<{familyId: string, recoveryHash: string, licenceId: string}>}
 */
async function checkKit(env, body) {
  const { familyId, recoverySecret, deviceId } = body ?? {};
  if (!ID.test(familyId ?? '') || !ID.test(deviceId ?? '')) throw new HttpError(400, 'bad-request');
  if (!isSecret(recoverySecret)) badKit();
  const recoveryHash = await sha256Hex(recoverySecret);
  const row = await env.DB.prepare('SELECT licence_id FROM families WHERE id = ? AND recovery_hash = ?').bind(familyId, recoveryHash).first();
  if (!row) badKit();
  return { familyId, recoveryHash, licenceId: row.licence_id };
}

async function recover(req, env) {
  await strictLimit(env, req);
  const body = await readJson(req);
  if (!ENC.test(body?.deviceNameEnc ?? '')) throw new HttpError(400, 'bad-request');
  const kit = await checkKit(env, body);
  const token = randomToken();
  const tokenHash = await sha256Hex(token);
  const at = nowIso();
  // One transaction: a device already in the family (a retried recovery) gets the new token;
  // otherwise it is added only while the family has room.
  const results = await env.DB.batch([
    env.DB.prepare('UPDATE devices SET token_hash = ?, last_seen_at = ? WHERE id = ? AND family_id = ?').bind(tokenHash, at, body.deviceId, kit.familyId),
    env.DB.prepare(
      `INSERT INTO devices (id, family_id, token_hash, name_enc, created_at, last_seen_at)
       SELECT ?, f.id, ?, ?, ?, ? FROM families f JOIN licences l ON l.id = f.licence_id
       WHERE f.id = ? AND f.recovery_hash = ? AND ${USED} < ${LIMIT}
       AND NOT EXISTS (SELECT 1 FROM devices WHERE id = ? AND family_id = f.id)`,
    ).bind(body.deviceId, tokenHash, body.deviceNameEnc, at, at, kit.familyId, kit.recoveryHash, body.deviceId),
  ]);
  if (results[0].meta.changes !== 1 && results[1].meta.changes !== 1) {
    await checkKit(env, body); // the family may have been purged meanwhile
    throw new HttpError(409, 'family-full', { devices: await devicesOf(env, kit.familyId) });
  }
  return json({ token, deviceLimit: await deviceLimit(env, kit.licenceId) });
}

async function recoverRemoveDevice(req, env) {
  await strictLimit(env, req);
  const body = await readJson(req);
  const kit = await checkKit(env, body);
  // No purge here even if no device is left: whoever holds the kit can still recover the data.
  await env.DB.prepare('DELETE FROM devices WHERE id = ? AND family_id = ?').bind(body.deviceId, kit.familyId).run();
  return json({ ok: true });
}

export const familyRoutes = {
  'GET /api/family': family,
  'POST /api/invites': createInvite,
  'GET /api/invites/info': inviteInfo,
  'POST /api/join': join,
  'DELETE /api/devices/:id': removeDevice,
  'POST /api/recover': recover,
  'POST /api/recover/remove-device': recoverRemoveDevice,
};
