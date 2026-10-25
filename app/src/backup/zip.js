// v2 backup container: a ZIP with backup.json + photos/<photoId>.<ext> (no base64, no giant string).
// Built and read entry by entry (zipio.js): peak memory stays near one photo, not the archive.
import { strToU8 } from 'fflate'
import { writeZip, verifyZip, readIndex, readEntry, measure, measureChunks, crc32 } from './zipio.js'
import { decodeImage } from '../photos.js'
import { DEFAULT_CATEGORIES } from '../categories.js'

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

const PLACES = ['school', 'home']
const EPOCH = '1970-01-01T00:00:00.000Z'
const str = (v) => (typeof v === 'string' ? v : '')
// The file is untrusted: only well-formed dates pass, anything else sorts as "oldest".
const isIso = (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v))
const iso = (v) => (isIso(v) ? v : EPOCH)

/** Exact Tab shape, or null when the id is unusable (its items then fail as 'missing-tab'). */
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

/** Exact Category shape, or null when the id is unusable. nameKey only for known default keys. */
function normCategory(c, index) {
  if (!str(c?.id)) return null
  const out = {
    id: c.id,
    name: String(c.name ?? '').trim() || 'Categoria',
    order: Number.isFinite(c.order) ? c.order : index,
    createdAt: iso(c.createdAt),
    updatedAt: iso(c.updatedAt),
  }
  // Only the key that belongs to this very default id (else a custom id could show a default's name).
  if (c.nameKey && c.nameKey === DEFAULT_CATEGORIES.find((d) => d.id === c.id)?.nameKey) out.nameKey = c.nameKey
  return out
}

/** Exact Item shape (unknown keys dropped), or the Failure reason. */
function normItem(raw) {
  if (!str(raw?.id) || !str(raw.tabId) || !str(raw.photoId)) return 'incomplete'
  if (!PLACES.includes(raw.location)) return 'unknown-place'
  const movedAt = iso(raw.movedAt)
  const item = {
    id: raw.id, tabId: raw.tabId, location: raw.location, label: String(raw.label ?? ''),
    photoId: raw.photoId, createdAt: isIso(raw.createdAt) ? raw.createdAt : movedAt, movedAt, updatedAt: iso(raw.updatedAt),
  }
  if (typeof raw.category === 'string') item.category = raw.category
  return item
}

/**
 * @param {{ tabs:any[], items:any[], categories?:any[], getPhoto:(id:string)=>Promise<Blob|undefined> }} src
 * @returns {Promise<Blob>}
 */
export async function buildZip({ tabs, items, categories = [], getPhoto, now = new Date() }) {
  const entries = []
  const integrity = {}
  const done = new Set()
  for (const it of items) {
    if (done.has(it.photoId)) continue
    done.add(it.photoId)
    const blob = await getPhoto(it.photoId)
    const ext = blob && extOf(blob.type)
    if (!ext) throw new Error(`missing-photo:${it.id}`)
    // Streamed once for the checksum; the Blob itself goes into the archive by reference.
    const m = await measure(blob)
    integrity[it.photoId] = m
    // Photos are already compressed: stored as they are.
    entries.push({ name: `photos/${it.photoId}.${ext}`, data: blob, ...m })
  }
  const meta = { app: 'andata-ritorno', version: 2, exportedAt: now.toISOString(), tabs, categories, items, photos: integrity }
  const json = strToU8(JSON.stringify(meta))
  entries.push({ name: 'backup.json', data: json, size: json.length, crc32: crc32(json) })
  const zip = writeZip(entries, now)
  // The archive references the photo Blobs: read it all back before anyone gets it.
  await verifyZip(zip, new Map(entries.map((e) => [e.name, { size: e.size, crc32: e.crc32 }])))
  return zip
}

/**
 * Items whose tab or photo is missing/unreadable become Failures (never reach the plan).
 * @param {Blob} blob
 * @param {{ localTabIds?:Iterable<string> }} [opts]  tabs already in the DB
 * @returns {Promise<Incoming>}
 */
export async function parseZip(blob, { localTabIds = [] } = {}) {
  let index
  let json
  try {
    index = await readIndex(blob)
    const meta = index.get('backup.json')
    if (!meta) throw new Error('bad-file')
    const chunks = await readEntry(blob, meta)
    const got = measureChunks(chunks)
    if (got.size !== meta.usize || got.crc32 !== meta.crc32) throw new Error('bad-file')
    json = JSON.parse(await new Blob(chunks).text())
  } catch {
    throw new Error('bad-file')
  }
  if (json?.app !== 'andata-ritorno' || json.version !== 2 || !Array.isArray(json.items) || !Array.isArray(json.tabs)) {
    throw new Error('bad-file')
  }

  const photoFiles = new Map() // photoId -> { entry, type }
  for (const [path, entry] of index) {
    const m = /^photos\/(.+)\.([a-z0-9]+)$/.exec(path)
    if (m) photoFiles.set(m[1], { entry, type: TYPE[m[2]] ?? 'application/octet-stream' })
  }
  // The `photos` integrity map is additive: a v2 file without it still imports, just unchecked.
  const integrity = json.photos && typeof json.photos === 'object' ? json.photos : {}
  const tabs = json.tabs.map(normTab).filter(Boolean)
  // Additive: v2 files from before categories have no array.
  const categories = Array.isArray(json.categories) ? json.categories.map(normCategory).filter(Boolean) : []
  const tabNames = new Map(tabs.map((t) => [t.id, t.name]))
  const known = new Set([...tabNames.keys(), ...localTabIds])

  // One read per photo, however many items share it; a failed read is remembered too.
  const read = new Map() // photoId -> Promise<Blob>
  const readPhoto = (photoId, file) => {
    if (!read.has(photoId)) {
      read.set(photoId, (async () => {
        const chunks = await readEntry(blob, file.entry)
        // The backup's own map when it has an entry, else the ZIP central directory.
        const want = integrity[photoId] ?? { size: file.entry.usize, crc32: file.entry.crc32 }
        const got = measureChunks(chunks)
        if (want.size !== got.size || want.crc32 !== got.crc32) throw new Error('corrupt')
        const photo = new Blob(chunks, { type: file.type })
        await decodeImage(photo)
        return photo
      })())
    }
    return read.get(photoId)
  }

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
    if (!known.has(item.tabId)) { fail('missing-tab'); continue }
    const file = photoFiles.get(item.photoId)
    if (!file) { fail('missing-photo'); continue }
    let photo
    try {
      photo = await readPhoto(item.photoId, file)
    } catch {
      fail('unreadable-photo'); continue
    }
    photos.set(item.photoId, photo)
    items.push(item)
  }
  return { tabs, categories, items, photos, failures }
}
