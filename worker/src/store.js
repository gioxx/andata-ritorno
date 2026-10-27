// Family data helpers shared by the licence and family routes.

export async function deviceLimit(env, licenceId) {
  const row = await env.DB.prepare('SELECT base_limit + extra_slots AS n FROM licences WHERE id = ?').bind(licenceId).first();
  return row.n;
}

/**
 * Statements deleting every row of a family (records, photos, invites, the family itself, devices)
 * and detaching it from its licence, which is kept. Each runs only if `guard` (an SQL condition)
 * holds, so a batch can make the purge depend on an earlier statement. Devices go last, so a guard
 * may require a device to exist; the families delete is second to last (its result tells whether
 * the purge ran).
 */
export function purgeStatements(db, familyId, guard = '1', guardArgs = []) {
  return [
    ...['records', 'photos', 'invites'].map((t) => db.prepare(`DELETE FROM ${t} WHERE family_id = ? AND ${guard}`).bind(familyId, ...guardArgs)),
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
