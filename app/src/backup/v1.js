// Reader for the mockup's JSON backup ({ app:'andata-ritorno', version:1, items:[…] }).
import { dataUrlToBlob, decodeImage } from '../photos.js'

/** @typedef {import('../types.js').Tab} Tab */
/** @typedef {import('../types.js').Item} Item */
/** @typedef {import('../types.js').Failure} Failure */
/** @typedef {import('../types.js').Incoming} Incoming */

// The mockup has no edit feature: its label/photo/tab must never beat a v2 edit.
const EPOCH = '1970-01-01T00:00:00.000Z'
const PLACES = ['school', 'home']
const tabNameFor = (child) => (child === 'nido' ? 'Nido' : child === 'materna' ? 'Materna' : child)
const str = (v) => (typeof v === 'string' ? v : '')

/** Read the first bytes to tell a v2 ZIP from a v1 JSON. */
export async function detectFormat(file) {
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer())
  if (head.length === 4 && head[0] === 0x50 && head[1] === 0x4b && head[2] === 3 && head[3] === 4) return 'v2'
  try {
    const data = JSON.parse(await file.text())
    if (data?.app === 'andata-ritorno' && data.version === 1) return 'v1'
  } catch { /* not JSON */ }
  return 'unknown'
}

/**
 * Turn a parsed v1 backup into Incoming. Every invalid item becomes a Failure.
 * `childMap` values: an existing tab id, or 'new' (create a tab); unmapped children
 * also get a new tab. Tabs are only created for children with at least one valid item.
 * @param {any} json
 * @param {{ childMap:Record<string,string>, now:string, tabs?:Tab[] }} opts  tabs = local tabs
 * @returns {Promise<Incoming>}
 */
export async function parseV1(json, { childMap, now, tabs = [] }) {
  if (!Array.isArray(json?.items)) throw new Error('bad-file')
  const localTabs = new Map(tabs.map((t) => [t.id, t]))
  let nextOrder = tabs.reduce((m, t) => Math.max(m, t.order + 1), 0)
  const target = new Map() // child -> { tab, isNew }, decided lazily per child
  const used = new Set() // children with at least one valid item
  const tabFor = (child) => {
    if (!target.has(child)) {
      const mapped = localTabs.get(childMap[child])
      target.set(child, mapped
        ? { tab: mapped, isNew: false }
        : { tab: { id: crypto.randomUUID(), name: tabNameFor(child), order: 0, createdAt: now, updatedAt: now }, isNew: true })
    }
    return target.get(child).tab
  }

  const items = []
  const photos = new Map()
  const failures = []
  for (const raw of json.items) {
    const child = str(raw?.child)
    const fail = (reason) => failures.push({
      itemId: str(raw?.id), label: str(raw?.label), tabName: child ? tabFor(child).name : '',
      location: str(raw?.location), reason,
    })
    if (!str(raw?.id) || !child) { fail('Dati incompleti'); continue }
    if (!PLACES.includes(raw.location)) { fail('Posto sconosciuto'); continue }
    let blob
    try {
      blob = dataUrlToBlob(raw.photo)
      await decodeImage(blob)
    } catch {
      fail('Foto non leggibile'); continue
    }
    const photoId = crypto.randomUUID()
    const movedAt = str(raw.movedAt) || EPOCH
    photos.set(photoId, blob)
    items.push({
      id: raw.id, tabId: tabFor(child).id, location: raw.location, label: str(raw.label),
      photoId, createdAt: movedAt, movedAt, updatedAt: EPOCH,
    })
    used.add(child)
  }

  const newTabs = []
  const resolved = {}
  for (const [child, { tab, isNew }] of target) {
    if (!used.has(child)) continue
    if (isNew) newTabs.push({ ...tab, order: nextOrder++ })
    resolved[child] = tab.id
  }
  return { tabs: newTabs, items, photos, failures, childMap: resolved }
}
