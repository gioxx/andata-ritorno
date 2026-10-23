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
const str = (v) => (typeof v === 'string' ? v : '')

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
  const tabNames = new Map(json.tabs.map((t) => [t.id, str(t.name)]))
  const known = new Set([...tabNames.keys(), ...localTabIds])

  const items = []
  const photos = new Map()
  const failures = []
  for (const raw of json.items) {
    const fail = (reason) => failures.push({
      itemId: str(raw?.id), label: str(raw?.label), tabName: tabNames.get(raw?.tabId) ?? '',
      location: str(raw?.location), reason,
    })
    if (!str(raw?.id) || !str(raw?.photoId)) { fail('Dati incompleti'); continue }
    if (!PLACES.includes(raw.location)) { fail('Posto sconosciuto'); continue }
    if (!known.has(raw.tabId)) { fail('Scheda mancante'); continue }
    const file = photoFiles.get(raw.photoId)
    if (!file) { fail('Foto mancante nel backup'); continue }
    const photo = new Blob([file.bytes], { type: file.type })
    const want = integrity[raw.photoId]
    try {
      if (want && (want.size !== file.bytes.length || want.crc32 !== crc32(file.bytes))) throw new Error('corrupt')
      await decodeImage(photo)
    } catch {
      fail('Foto non leggibile'); continue
    }
    photos.set(raw.photoId, photo)
    items.push(raw)
  }
  return { tabs: json.tabs, items, photos, failures }
}
