// Family data helpers shared by the licence and family routes.
import { HttpError } from './http.js';

export async function deviceLimit(env, licenceId) {
  const row = await env.DB.prepare('SELECT base_limit + extra_slots AS n FROM licences WHERE id = ?').bind(licenceId).first();
  if (!row) throw new HttpError(401, 'unauthorized');
  return row.n;
}

// Daily budgets, in units: one per record pushed, PHOTO_UNITS per photo uploaded, PULL_UNITS per
// full page pulled, OP_UNITS per other write (invite, photo delete). Far above a family's real use
// (a first sync of a large wardrobe fits), they stop one device (a buggy loop, or someone with a
// paid code) from eating the account's daily D1 allowances. The family has its own budget on top,
// so new device ids (a recovery kit) do not bring fresh units.
export const DAILY_UNITS = 5000;
export const FAMILY_DAILY_UNITS = 15000;
export const PHOTO_UNITS = 4;
export const PULL_UNITS = 10;
export const OP_UNITS = 1;
const familyKey = (familyId) => `f:${familyId}`; // ':' never occurs in a device id (ID)
const today = () => new Date().toISOString().slice(0, 10);

const SPEND = `INSERT INTO device_usage (device_id, day, units) SELECT ?1, ?2, ?3 WHERE ?3 <= ?4 AND GUARD
  ON CONFLICT(device_id) DO UPDATE SET units = CASE WHEN day = ?2 THEN units + ?3 ELSE ?3 END, day = ?2
  WHERE (CASE WHEN day = ?2 THEN units ELSE 0 END) + ?3 <= ?4 AND GUARD`;

/**
 * The two statements spending `units` of the device's and then the family's budget for today. The
 * second changes a row only if the first did and the units fit, so the statements after it in a
 * batch can depend on it with changes() = 1. A new day starts from zero.
 */
export function spendDaily(db, deviceId, units, familyId) {
  const day = today();
  return [
    db.prepare(SPEND.replaceAll('GUARD', '1')).bind(deviceId, day, units, DAILY_UNITS),
    db.prepare(SPEND.replaceAll('GUARD', 'changes() = 1')).bind(familyKey(familyId), day, units, FAMILY_DAILY_UNITS),
  ];
}

/** Spend now, outside a larger batch; HttpError 429 limit-daily when either budget is used up. */
export async function spendNow(db, deviceId, units, familyId) {
  const r = await db.batch(spendDaily(db, deviceId, units, familyId));
  if (r[1].meta.changes !== 1) throw new HttpError(429, 'limit-daily');
}

/** Refuse (429 limit-daily) before doing work that would cost `units`, without spending them. */
export async function requireBudget(db, deviceId, units, familyId) {
  const over = await db
    .prepare('SELECT 1 FROM device_usage WHERE day = ?1 AND ((device_id = ?2 AND units + ?4 > ?5) OR (device_id = ?3 AND units + ?4 > ?6)) LIMIT 1')
    .bind(today(), deviceId, familyKey(familyId), units, DAILY_UNITS, FAMILY_DAILY_UNITS)
    .first();
  if (over) throw new HttpError(429, 'limit-daily');
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
    db.prepare(`DELETE FROM device_usage WHERE (device_id IN (SELECT id FROM devices WHERE family_id = ?) OR device_id = ?) AND ${guard}`).bind(familyId, familyKey(familyId), ...guardArgs),
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
 * Delete the photo objects of a family whose rows were purged. A failure is logged and queued in
 * pending_purges, which the daily cron (sweep) retries, so no ciphertext stays behind for good.
 */
export async function purgePhotos(env, familyId) {
  try {
    await deletePrefix(env.PHOTOS, `${familyId}/`);
  } catch (e) {
    console.error('photo purge failed', familyId, e);
    await env.DB.prepare('INSERT OR IGNORE INTO pending_purges (family_id, since) VALUES (?, ?)')
      .bind(familyId, new Date().toISOString())
      .run()
      .catch((e2) => console.error('photo purge not queued', familyId, e2));
  }
}

/**
 * Daily housekeeping (cron): retry queued photo purges and drop rows nothing reads any more
 * (yesterday's budgets, licence links past their last use).
 */
export async function sweep(env) {
  const { results } = await env.DB.prepare('SELECT family_id FROM pending_purges LIMIT 100').all();
  for (const { family_id: id } of results) {
    // A family id that came back (restarted with the same id) keeps its objects.
    if (await env.DB.prepare('SELECT 1 FROM families WHERE id = ?').bind(id).first()) {
      await env.DB.prepare('DELETE FROM pending_purges WHERE family_id = ?').bind(id).run();
      continue;
    }
    try {
      await deletePrefix(env.PHOTOS, `${id}/`);
      await env.DB.prepare('DELETE FROM pending_purges WHERE family_id = ?').bind(id).run();
    } catch (e) {
      console.error('photo purge retry failed', id, e);
    }
  }
  const yesterday = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
  const weekAgo = new Date(Date.now() - 7 * 864e5).toISOString();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM device_usage WHERE day < ?').bind(yesterday),
    env.DB.prepare('DELETE FROM licence_links WHERE expires_at < ?').bind(weekAgo),
  ]);
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
