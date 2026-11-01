// Family data helpers shared by the licence and family routes.
import { HttpError } from './http.js';

export async function deviceLimit(env, licenceId) {
  const row = await env.DB.prepare('SELECT base_limit + extra_slots AS n FROM licences WHERE id = ?').bind(licenceId).first();
  return row.n;
}

// A device's daily write budget, in units: one per record pushed, PHOTO_UNITS per photo uploaded.
// Far above a family's real use (a first sync of a large wardrobe fits), it stops one device (a
// buggy loop, or someone with a paid code) from eating the account's daily D1 write allowance.
export const DAILY_UNITS = 5000;
export const PHOTO_UNITS = 4;

/**
 * The statement spending `units` of the device's budget for today: it changes a row only if they
 * fit, so the statements after it in a batch can depend on it with changes() = 1. A new day starts
 * from zero.
 */
export function spendDaily(db, deviceId, units) {
  const day = new Date().toISOString().slice(0, 10);
  return db
    .prepare(
      `INSERT INTO device_usage (device_id, day, units) SELECT ?1, ?2, ?3 WHERE ?3 <= ?4
       ON CONFLICT(device_id) DO UPDATE SET units = CASE WHEN day = ?2 THEN units + ?3 ELSE ?3 END, day = ?2
       WHERE (CASE WHEN day = ?2 THEN units ELSE 0 END) + ?3 <= ?4`,
    )
    .bind(deviceId, day, units, DAILY_UNITS);
}

/**
 * Statements deleting every row of a family (records, photos, invites, the family itself, devices)
 * and detaching it from its licence, which is kept. Each runs only if `guard` (an SQL condition)
 * holds, so a batch can make the purge depend on an earlier statement. Devices go last, so a guard
 * may require a device to exist; the families delete is second to last (its result tells whether
 * the purge ran). The first statement frees the family's photo bytes from the global total.
 */
export function purgeStatements(db, familyId, guard = '1', guardArgs = []) {
  return [
    db
      .prepare(
        `UPDATE usage SET bytes = MAX(0, bytes - COALESCE((SELECT SUM(size) FROM photos WHERE family_id = ?), 0)) WHERE key = 'photo_bytes' AND ${guard}`,
      )
      .bind(familyId, ...guardArgs),
    ...['records', 'photos', 'invites'].map((t) => db.prepare(`DELETE FROM ${t} WHERE family_id = ? AND ${guard}`).bind(familyId, ...guardArgs)),
    db.prepare(`DELETE FROM device_usage WHERE device_id IN (SELECT id FROM devices WHERE family_id = ?) AND ${guard}`).bind(familyId, ...guardArgs),
    db.prepare(`UPDATE licences SET family_id = NULL WHERE family_id = ? AND ${guard}`).bind(familyId, ...guardArgs),
    db.prepare(`DELETE FROM families WHERE id = ? AND ${guard}`).bind(familyId, ...guardArgs),
    db.prepare(`DELETE FROM devices WHERE family_id = ? AND ${guard}`).bind(familyId, ...guardArgs),
  ];
}

/** Delete every R2 object under prefix. */
export async function deletePrefix(bucket, prefix) {
  let cursor;
  do {
    const page = await bucket.list({ prefix, cursor });
    if (page.objects.length) await bucket.delete(page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

/**
 * Delete the photo objects of a family whose rows were purged. Best effort: the rows are already
 * gone, so a failure only leaves unreachable ciphertext behind; it is logged, not thrown.
 */
export async function purgePhotos(env, familyId) {
  try {
    await deletePrefix(env.PHOTOS, `${familyId}/`);
  } catch (e) {
    console.error('photo purge failed', familyId, e);
  }
}

/**
 * The owner's emergency brake, switched from the admin page: while registrations are closed no new
 * family is created and no new phone joins one (503 registrations-closed). Families already in keep
 * syncing, and a recovery kit still brings one of their phones back.
 */
export async function requireRegistrationsOpen(env) {
  if (!(await registrationsOpen(env))) throw new HttpError(503, 'registrations-closed');
}

export async function registrationsOpen(env) {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'registrations'").first();
  return row?.value !== 'closed';
}
