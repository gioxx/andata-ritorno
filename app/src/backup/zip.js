// v2 backup container: a ZIP with backup.json + photos/<photoId>.<ext> (no base64, no giant string).
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate'
import { decodeImage } from '../photos.js'

/** @typedef {import('../types.js').Incoming} Incoming */
/** @typedef {import('../types.js').Failure} Failure */

const TYPE = {
  webp: 'image/webp', jpg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  avif: 'image/avif', heic: 'image/heic', bmp: 'image/bmp',
}
// image/jpeg -> jpg, image/png -> png, ...; null when the blob is not an image.
const extOf = (type) => {
  const sub = /^image\/([a-z0-9]+)/.exec(type ?? '')?.[1]
  return sub === 'jpeg' ? 'jpg' : sub ?? null
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
// fflate's unzipSync does not verify CRCs, so the backup carries its own.
const crc32 = (bytes) => {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const PLACES = ['school', 'home']
const EPOCH = '1970-01-01T00:00:00.000Z'
const str = (v) => (typeof v === 'string' ? v : '')
// The file is untrusted: only well-formed dates pass, anything else sorts as "oldest".
const isIso = (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v))
const iso = (v) => (isIso(v) ? v : EPOCH)

/** Exact Tab shape, or null when the id is unusable (its items then fail as 'Scheda mancante'). */
function normTab(t, index) {
  if (!str(t?.id)) return null
  return {
    id: t.id,
    name: String(t.name ?? '').trim() || 'Scheda',
    order: Number.isFinite(t.order) ? t.order : index,
    createdAt: iso(t.createdAt),
    updatedAt: iso(t.updatedAt),
  }
}

/** Exact Item shape (unknown keys dropped), or the Failure reason. */
function normItem(raw) {
  if (!str(raw?.id) || !str(raw.tabId) || !str(raw.photoId)) return 'Dati incompleti'
  if (!PLACES.includes(raw.location)) return 'Posto sconosciuto'
  const movedAt = iso(raw.movedAt)
  const item = {
    id: raw.id, tabId: raw.tabId, location: raw.location, label: String(raw.label ?? ''),
    photoId: raw.photoId, createdAt: isIso(raw.createdAt) ? raw.createdAt : movedAt, movedAt, updatedAt: iso(raw.updatedAt),
  }
  if (typeof raw.category === 'string') item.category = raw.category
  return item
}

/**
 * @param {{ tabs:any[], items:any[], getPhoto:(id:string)=>Promise<Blob|undefined> }} src
 * @returns {Promise<Blob>}
 */
export async function buildZip({ tabs, items, getPhoto, now = new Date() }) {
  const files = {}
  const integrity = {}
  const done = new Set()
  for (const it of items) {
    if (done.has(it.photoId)) continue
    done.add(it.photoId)
    const blob = await getPhoto(it.photoId)
    const ext = blob && extOf(blob.type)
    if (!ext) throw new Error(`missing-photo:${it.id}`)
    const bytes = new Uint8Array(await blob.arrayBuffer())
    integrity[it.photoId] = { size: bytes.length, crc32: crc32(bytes) }
    // Photos are already compressed: store them, level 0.
    files[`photos/${it.photoId}.${ext}`] = [bytes, { level: 0 }]
  }
  const meta = { app: 'andata-ritorno', version: 2, exportedAt: now.toISOString(), tabs, items, photos: integrity }
  files['backup.json'] = strToU8(JSON.stringify(meta))
  return new Blob([zipSync(files)], { type: 'application/zip' })
}

/**
 * Items whose tab or photo is missing/unreadable become Failures (never reach the plan).
 * @param {Blob} blob
 * @param {{ localTabIds?:Iterable<string> }} [opts]  tabs already in the DB
 * @returns {Promise<Incoming>}
 */
export async function parseZip(blob, { localTabIds = [] } = {}) {
  let entries
  try {
    entries = unzipSync(new Uint8Array(await blob.arrayBuffer()))
  } catch {
    throw new Error('bad-file')
  }
  let json
  try {
    json = JSON.parse(strFromU8(entries['backup.json']))
  } catch {
    throw new Error('bad-file')
  }
  if (json?.app !== 'andata-ritorno' || json.version !== 2 || !Array.isArray(json.items) || !Array.isArray(json.tabs)) {
    throw new Error('bad-file')
  }

  const photoFiles = new Map() // photoId -> { bytes, type }
  for (const [path, bytes] of Object.entries(entries)) {
    const m = /^photos\/(.+)\.([a-z0-9]+)$/.exec(path)
    if (m) photoFiles.set(m[1], { bytes, type: TYPE[m[2]] ?? 'application/octet-stream' })
  }
  // The `photos` integrity map is additive: a v2 file without it still imports, just unchecked.
  const integrity = json.photos && typeof json.photos === 'object' ? json.photos : {}
  const tabs = json.tabs.map(normTab).filter(Boolean)
  const tabNames = new Map(tabs.map((t) => [t.id, t.name]))
  const known = new Set([...tabNames.keys(), ...localTabIds])

  const items = []
  const photos = new Map()
  const failures = []
  for (const raw of json.items) {
    const fail = (reason) => failures.push({
      itemId: str(raw?.id), label: String(raw?.label ?? ''), tabName: tabNames.get(raw?.tabId) ?? '',
      location: str(raw?.location), reason,
    })
    const item = normItem(raw)
    if (typeof item === 'string') { fail(item); continue }
    if (!known.has(item.tabId)) { fail('Scheda mancante'); continue }
    const file = photoFiles.get(item.photoId)
    if (!file) { fail('Foto mancante nel backup'); continue }
    const photo = new Blob([file.bytes], { type: file.type })
    const want = integrity[item.photoId]
    try {
      if (want && (want.size !== file.bytes.length || want.crc32 !== crc32(file.bytes))) throw new Error('corrupt')
      await decodeImage(photo)
    } catch {
      fail('Foto non leggibile'); continue
    }
    photos.set(item.photoId, photo)
    items.push(item)
  }
  return { tabs, items, photos, failures }
}
