import { encryptJson, decryptJson } from './crypto.js'

/** @typedef {import('../types.js').Tombstone} Tombstone */

export const recordAad = (familyId, rid) => `${familyId}:${rid}`

/** Plaintext is {k, v, by}; the server only ever sees rid and the opaque blob. */
export async function encodeRecord(key, familyId, { kind, value, by }) {
  const rid = value.id
  return { rid, data: await encryptJson(key, recordAad(familyId, rid), { k: kind, v: value, by }) }
}

export async function encodeTombstone(key, familyId, { kind, id, deletedAt, by }) {
  return { rid: id, data: await encryptJson(key, recordAad(familyId, id), { k: kind, dead: { id, deletedAt }, by }) }
}

/** @returns {Promise<{rid:string, seq:number, kind:string, value?:any, tombstone?:Tombstone, by:string}>} */
export async function decodeRecord(key, familyId, { rid, seq, data }) {
  const p = await decryptJson(key, recordAad(familyId, rid), data)
  const out = { rid, seq, kind: p.k, by: p.by }
  if (p.dead) out.tombstone = { kind: p.k, id: p.dead.id, deletedAt: p.dead.deletedAt }
  else out.value = p.v
  return out
}
