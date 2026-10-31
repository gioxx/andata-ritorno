// Family membership on this device: the stored family (meta key 'family') and the flows that
// create, join, recover, restart or leave one. Creating, joining or recovering turns sync tracking
// on and queues every local tab, category and item, so local data uploads on the next sync.
import { getMeta, setMeta, deleteMeta, setSyncTracking, markAllDirty, queueOutbox, clearSyncStores, clearWardrobe } from '../db.js'
import { generateKeyRaw, importKey, encryptJson, decryptJson, b64url, randomToken, sha256Hex } from './crypto.js'

/**
 * keyRaw: the family key, base64url. recoverySecret is null on a device that joined by invite
 * (the invite carries the key only). pending: a redeem/restart/join/recover sent but not yet
 * answered (mode: how a join treats the local wardrobe).
 * removed: the server no longer knows this device (sync stops until it leaves or rejoins).
 * @typedef {{ familyId:string, deviceId:string, token:string|null, keyRaw:string, recoverySecret:string|null,
 *   cursor:number, lastSyncAt:string|null, licenceKind:'family', deviceLimit?:number,
 *   pending?:{op:'redeem'|'restart'|'join'|'recover', body:object, mode?:'merge'|'replace'}, removed?:boolean }} FamilyMeta
 */

const META = 'family'
const ID = /^[A-Za-z0-9_-]{8,64}$/
const TOKEN = /^[A-Za-z0-9_-]{1,128}$/
const KEY_B64 = /^[A-Za-z0-9_-]{43}$/ // 32 bytes, unpadded
const KIT_PREFIX = 'ARKIT1'

/**
 * The recovery secret travels to every device as one encrypted sync record (an invite carries
 * only the key): kind 'kit', value {id: KIT_RID, recoverySecret}. Never tombstoned.
 */
export const KIT_KIND = 'kit'
export const KIT_RID = 'family-kit'
export const isRecoverySecret = (s) => typeof s === 'string' && TOKEN.test(s)

/** @returns {Promise<FamilyMeta|null>} */
export const getFamily = async (db) => (await getMeta(db, META)) ?? null
/** @param {FamilyMeta} meta */
export const setFamily = (db, meta) => setMeta(db, META, meta)
export const clearFamily = (db) => deleteMeta(db, META)

/** Whether the stored family is still the one `meta` describes (same family, same device). */
export const sameMembership = (cur, meta) => !!cur && !!meta && cur.familyId === meta.familyId && cur.deviceId === meta.deviceId

/**
 * Merge `patch` into the stored family, only if it is still the membership `match` describes: a
 * sync finishing after the user left (or joined again) must not write into the new one.
 * @param {{familyId:string, deviceId:string}} match
 * @returns {Promise<FamilyMeta|null>}
 */
export async function updateFamily(db, match, patch) {
  // Read and write in one transaction: a leave (or join) cannot land between them and be undone.
  const tx = db.transaction('meta', 'readwrite')
  const cur = (await tx.store.get(META)) ?? null
  if (!sameMembership(cur, match)) {
    await tx.done
    return null
  }
  const next = { ...cur, ...patch }
  await tx.store.put(next, META)
  await tx.done
  return next
}

export const familyKey = (meta) => importKey(b64url.decode(meta.keyRaw))
const familyNameAad = (familyId) => `${familyId}:family-name`
const deviceAad = (familyId, deviceId) => `${familyId}:device:${deviceId}`

/** A name that cannot be decrypted (or is missing) shows as null rather than failing the screen. */
async function openName(key, aad, enc) {
  try {
    const v = await decryptJson(key, aad, enc)
    return typeof v === 'string' ? v : null
  } catch {
    return null
  }
}

/** @param {{id:string, nameEnc:string, createdAt:string, lastSeenAt:string}[]} devices */
export async function openDevices(key, familyId, devices, thisDeviceId) {
  return Promise.all(devices.map(async (d) => ({
    id: d.id, name: await openName(key, deviceAad(familyId, d.id), d.nameEnc),
    createdAt: d.createdAt, lastSeenAt: d.lastSeenAt, isThis: d.id === thisDeviceId,
  })))
}

/** GET /api/family decrypted for display. */
export async function describeFamily(key, res) {
  return {
    name: await openName(key, familyNameAad(res.familyId), res.familyNameEnc),
    deviceLimit: res.deviceLimit,
    devices: await openDevices(key, res.familyId, res.devices, res.you),
  }
}

/** Decrypt the family name of an invite (GET /api/invites/info) with the key from its link. */
export async function inviteFamilyName({ familyId, keyRaw }, familyNameEnc) {
  return openName(await importKey(b64url.decode(keyRaw)), familyNameAad(familyId), familyNameEnc)
}

/** A create/join call whose answer was lost is sent again once, same body: the server replays it. */
async function withRetry(fn) {
  try {
    return await fn()
  } catch (e) {
    if (e?.status !== 0) throw e
    return fn()
  }
}

const newMeta = ({ familyId, deviceId, keyRaw, recoverySecret }) => ({
  familyId, deviceId, token: null, keyRaw, recoverySecret, cursor: 0, lastSyncAt: null, licenceKind: 'family',
})

/** Meta key: ids of empty local tabs a joining phone keeps (hidden from upload) until its first pull. */
export const EMPTY_TABS_META = 'emptyTabsToDrop'

/**
 * Start tracking, queue everything, then store the family: from here every local change is queued
 * for upload. The membership is written last, so until the queue is complete the stored attempt
 * stays pending and an interrupted start is replayed (and queued again) on the next one.
 * `dropEmptyTabs` (join/recover): tabs without items are not queued; the engine deletes them
 * after the first successful pull, so the phone never shows the welcome screen in between.
 */
async function enter(db, meta, { token, deviceLimit }, { dropEmptyTabs = false } = {}) {
  const { pending: _p, removed: _r, ...rest } = meta
  const done = { ...rest, token, deviceLimit }
  await deleteMeta(db, 'orphanSeen')
  await deleteMeta(db, 'photosRefused')
  // Tracking first, then queue everything: an edit in between is covered either way.
  setSyncTracking(true)
  await clearSyncStores(db)
  const empty = await markAllDirty(db, { skipEmptyTabs: dropEmptyTabs })
  if (empty.length) await setMeta(db, EMPTY_TABS_META, empty)
  else await deleteMeta(db, EMPTY_TABS_META)
  if (done.recoverySecret) await queueOutbox(db, KIT_KIND, KIT_RID) // lets invited devices show the kit
  await setFamily(db, done)
  return done
}

/** Fields of a brand-new family and its first device, as redeem and restart send them. */
async function newFamily({ familyName, deviceName }) {
  const keyRaw = b64url.encode(generateKeyRaw())
  const ids = { familyId: crypto.randomUUID(), deviceId: crypto.randomUUID(), keyRaw, recoverySecret: randomToken() }
  const key = await importKey(b64url.decode(keyRaw))
  const body = {
    familyId: ids.familyId,
    deviceId: ids.deviceId,
    familyNameEnc: await encryptJson(key, familyNameAad(ids.familyId), familyName),
    deviceNameEnc: await encryptJson(key, deviceAad(ids.familyId, ids.deviceId), deviceName),
    recoveryHash: await sha256Hex(ids.recoverySecret),
  }
  return { ids, body }
}

/**
 * A refusal that will not change on retry. Rate limits (429), timeouts and server errors may come
 * after the server already acted on the first attempt: those keep the attempt for a replay.
 */
const definitive = (e) => e?.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429

/** The resume in flight per database: the engine and a dialog may both try to finish the same one. */
const resuming = new WeakMap()

/**
 * Finish a redeem/restart that was stored as pending (called right away, and again at the next
 * start if the answer never came). A definitive refusal forgets the attempt; no answer, a rate
 * limit or a server error keeps it, so the next start replays the same body. Single-flight: a
 * call while one runs gets the same result.
 * @returns {Promise<FamilyMeta|null>}
 */
export function resumePending(db, api) {
  if (!resuming.has(db)) resuming.set(db, resumeOnce(db, api).finally(() => resuming.delete(db)))
  return resuming.get(db)
}

async function resumeOnce(db, api) {
  const meta = await getFamily(db)
  if (!meta?.pending) return meta
  const { op, body, mode } = meta.pending
  const method = { restart: 'licenceRestart', redeem: 'redeem', join: 'join', recover: 'recover' }[op]
  let res
  try {
    res = await withRetry(() => api[method](body))
  } catch (e) {
    if (definitive(e) && (await getFamily(db))?.familyId === meta.familyId) await clearFamily(db)
    throw e
  }
  // 'replace' empties the local wardrobe only once the server accepted the device.
  if (op === 'join' && mode === 'replace') await clearWardrobe(db)
  return enter(db, meta, res, { dropEmptyTabs: op === 'join' || op === 'recover' })
}

/**
 * Another attempt is still unanswered: finish it before starting a new one, since its stored device
 * id is the only way to reach a device the server may already have added. Refused for good, it is
 * forgotten and the new attempt goes ahead; accepted, this phone is in that family now
 * (ApiError-like `already-in-family`); no answer again, the new attempt waits (that error).
 */
async function settlePrevious(db, api) {
  try {
    await resumePending(db, api)
  } catch (e) {
    if (definitive(e)) return
    throw e
  }
  throw Object.assign(new Error('already-in-family'), { code: 'already-in-family' })
}

/** Change the stored pending attempt (same membership), e.g. the join mode chosen on a retry. */
async function updatePending(db, pending) {
  const cur = await getFamily(db)
  if (cur?.pending) await setFamily(db, { ...cur, pending })
}

/**
 * Creating or restarting never replaces a family already set up (its key would be lost), nor an
 * attempt still unanswered: that one is finished first (settlePrevious).
 */
async function refuseIfSetUp(db, api) {
  await resuming.get(db)?.catch(() => {})
  const cur = await getFamily(db)
  if (cur?.pending) await settlePrevious(db, api)
  else if (cur) throw Object.assign(new Error('already-in-family'), { code: 'already-in-family' })
}

/** Redeem an unlock code: a new family with this device in it. */
export async function createFamily(db, api, { code, familyName, deviceName }) {
  await refuseIfSetUp(db, api)
  const { ids, body } = await newFamily({ familyName, deviceName })
  // Saved before the call: if the answer is lost, the key and secret are not.
  await setFamily(db, { ...newMeta(ids), pending: { op: 'redeem', body: { code, ...body } } })
  return resumePending(db, api)
}

/** A licence-recovery link: a fresh family on the same licence (the old one is wiped on the server). */
export async function restartFromLicence(db, api, { linkToken, familyName, deviceName }) {
  await refuseIfSetUp(db, api)
  const { ids, body } = await newFamily({ familyName, deviceName })
  await setFamily(db, { ...newMeta(ids), pending: { op: 'restart', body: { linkToken, ...body } } })
  return resumePending(db, api)
}

/**
 * Join with an invite. 'replace' empties the local wardrobe only once the server accepted the
 * device (the UI has already saved a backup); 'merge' keeps it and uploads it.
 * @param {{inviteToken:string, familyId:string, keyRaw:string, deviceName:string, mode:'merge'|'replace'}} p
 */
export async function joinFamily(db, api, { inviteToken, familyId, keyRaw, deviceName, mode = 'merge' }) {
  const prev = (await getFamily(db))?.pending
  // The same invite tried before with no answer: same device id, so the server replays it.
  if (prev?.op === 'join' && prev.body.inviteToken === inviteToken) {
    await updatePending(db, { ...prev, mode })
    return resumePending(db, api)
  }
  if (prev) await settlePrevious(db, api)
  const key = await importKey(b64url.decode(keyRaw))
  const deviceId = crypto.randomUUID()
  const deviceNameEnc = await encryptJson(key, deviceAad(familyId, deviceId), deviceName)
  // Saved before the call: if the answer is lost (or the page closes), the next try or start
  // replays it instead of leaving a device in the family that no phone holds.
  await setFamily(db, { ...newMeta({ familyId, deviceId, keyRaw, recoverySecret: null }), pending: { op: 'join', body: { inviteToken, deviceId, deviceNameEnc }, mode } })
  return resumePending(db, api)
}

/**
 * Rejoin with a recovery kit. A full family rejects with ApiError family-full whose
 * `extra.devices` carry decrypted names, so the user can pick one to remove.
 * @param {string|{familyId:string, keyRaw:string, recoverySecret:string}} kit
 */
export async function recoverFamily(db, api, kit, deviceName) {
  const { familyId, keyRaw, recoverySecret } = typeof kit === 'string' ? parseKit(kit) : kit
  const key = await importKey(b64url.decode(keyRaw))
  const prev = (await getFamily(db))?.pending
  // The same kit tried before with no answer: same device id, so the server gives it a new token
  // instead of adding another device.
  if (!(prev?.op === 'recover' && prev.body.familyId === familyId && prev.body.recoverySecret === recoverySecret)) {
    if (prev) await settlePrevious(db, api)
    const deviceId = crypto.randomUUID()
    const deviceNameEnc = await encryptJson(key, deviceAad(familyId, deviceId), deviceName)
    await setFamily(db, { ...newMeta({ familyId, deviceId, keyRaw, recoverySecret }), pending: { op: 'recover', body: { familyId, recoverySecret, deviceId, deviceNameEnc } } })
  }
  try {
    return await resumePending(db, api)
  } catch (e) {
    if (e?.code === 'family-full' && Array.isArray(e.extra?.devices)) e.extra.devices = await openDevices(key, familyId, e.extra.devices, null)
    throw e
  }
}

/**
 * Leave: the server forgets this device (the last one out wipes the family's server data), the
 * device forgets the family. Local data stays as a plain local wardrobe.
 * @param {{timeoutMs?: number}} [o] timeoutMs: give up on the server (throws ApiError offline)
 * @returns {Promise<{purged:boolean}>}
 */
export async function leaveFamily(db, api, { timeoutMs } = {}) {
  const meta = await getFamily(db)
  if (!meta) return { purged: false }
  let purged = false
  if (meta.token && !meta.removed) {
    try {
      ;({ purged } = await api.removeDevice(meta.deviceId, timeoutMs ? { timeoutMs } : undefined))
    } catch (e) {
      if (e?.status !== 401) throw e // already removed by someone else: nothing left to revoke
    }
  }
  setSyncTracking(false)
  await clearFamily(db)
  await deleteMeta(db, 'orphanSeen')
  await deleteMeta(db, 'photosRefused')
  await deleteMeta(db, EMPTY_TABS_META)
  await clearSyncStores(db)
  return { purged }
}

/** The recovery kit as one pasteable string. */
export function kitOf(meta) {
  if (!meta?.recoverySecret) throw new Error('no-kit')
  return `${KIT_PREFIX}.${meta.familyId}.${meta.keyRaw}.${meta.recoverySecret}`
}

const isKey = (s) => KEY_B64.test(s ?? '') && b64url.decode(s).length === 32

/** @returns {{familyId:string, keyRaw:string, recoverySecret:string}} throws Error('bad-kit') */
export function parseKit(str) {
  const parts = String(str ?? '').replace(/\s+/g, '').split('.')
  const [prefix, familyId, keyRaw, recoverySecret] = parts
  if (parts.length !== 4 || prefix !== KIT_PREFIX || !ID.test(familyId) || !isKey(keyRaw) || !TOKEN.test(recoverySecret)) {
    throw new Error('bad-kit')
  }
  return { familyId, keyRaw, recoverySecret }
}

/** `<origin>/join#<invite token>.<family id>.<family key>`: the part after # never reaches a server. */
export function inviteLink(token, meta, origin = globalThis.location?.origin ?? '') {
  return `${origin}/join#${token}.${meta.familyId}.${meta.keyRaw}`
}

/**
 * Accepts the full link, its `#…` fragment or the bare fragment.
 * @returns {{inviteToken:string, familyId:string, keyRaw:string}} throws Error('bad-invite')
 */
export function parseInvite(urlOrHash) {
  let s = String(urlOrHash ?? '').trim()
  const hash = s.indexOf('#')
  if (hash >= 0) s = s.slice(hash + 1)
  const parts = s.split('.')
  const [inviteToken, familyId, keyRaw] = parts
  if (parts.length !== 3 || !TOKEN.test(inviteToken) || !ID.test(familyId) || !isKey(keyRaw)) throw new Error('bad-invite')
  return { inviteToken, familyId, keyRaw }
}
