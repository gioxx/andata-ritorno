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

const ID = /^[A-Za-z0-9_-]{8,64}$/
// How far ahead of this device's clock a record's time may be: last-write-wins would otherwise let
// one far-future date beat every later edit, on every device, forever.
const MAX_SKEW_MS = 2 * 24 * 60 * 60 * 1000
const isStr = (v) => typeof v === 'string'
const isId = (v) => isStr(v) && ID.test(v)

/** An ISO date not later than now + MAX_SKEW_MS. */
export function isSaneTime(v, nowMs = Date.now()) {
  if (!isStr(v)) return false
  const t = Date.parse(v)
  return !Number.isNaN(t) && t <= nowMs + MAX_SKEW_MS
}

const SHAPES = {
  tab: (v) => isStr(v.name) && Number.isFinite(v.order),
  category: (v) => isStr(v.name) && Number.isFinite(v.order),
  item: (v) =>
    isId(v.tabId) && isId(v.photoId) && ['school', 'home'].includes(v.location) && isStr(v.label) &&
    isSaneTime(v.movedAt) && (v.photoAt === undefined || isSaneTime(v.photoAt)) && (v.category === undefined || isStr(v.category)),
}

/**
 * Whether a decoded record of a known kind has the shape the merge relies on; kinds from a newer
 * app version are left alone. One malformed record (a bug, a newer client, a hostile member) must
 * be skipped, not stop every device's sync on a throw.
 */
function wellFormed(rid, p) {
  const shape = SHAPES[p?.k]
  if (!shape) return true
  if (p.dead) return p.dead.id === rid && isSaneTime(p.dead.deletedAt)
  const v = p.v
  return !!v && typeof v === 'object' && v.id === rid && isId(rid) && isSaneTime(v.updatedAt) && shape(v)
}

/** @returns {Promise<{rid:string, seq:number, kind:string, value?:any, tombstone?:Tombstone, by:string}>} */
export async function decodeRecord(key, familyId, { rid, seq, data }) {
  const p = await decryptJson(key, recordAad(familyId, rid), data)
  if (!wellFormed(rid, p)) throw new Error('malformed record')
  const out = { rid, seq, kind: p.k, by: p.by }
  if (p.dead) out.tombstone = { kind: p.k, id: p.dead.id, deletedAt: p.dead.deletedAt }
  else out.value = p.v
  return out
}
