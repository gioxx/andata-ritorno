// Merge pulled sync records into local state. Pure: no I/O and no clock (time comes in as
// `now`); the result is a plan that db.applySyncPlan writes in one transaction.
// ISO strings compare lexicographically. Exact ties with different content go to the greater
// JSON (key order normalised) so every device converges; a deletion wins an exact tie.
import { mergeItem } from '../backup/merge.js'
import { byOrder } from '../order.js'

/** @typedef {import('../types.js').Tab} Tab */
/** @typedef {import('../types.js').Category} Category */
/** @typedef {import('../types.js').Item} Item */
/** @typedef {import('../types.js').Tombstone} Tombstone */
/** @typedef {import('../types.js').SyncPlan} SyncPlan */
/** @typedef {{rid:string, seq:number, kind:string, value?:any, tombstone?:Tombstone, by:string}} DecodedRecord */

const KINDS = ['tab', 'category', 'item']

/** Newest moment a record was touched: what a tombstone's deletedAt must beat. */
function stamp(kind, r) {
  if (kind !== 'item') return r.updatedAt
  return [r.updatedAt, r.movedAt, r.photoAt ?? ''].reduce((a, b) => (b > a ? b : a))
}

/** Equality over both key sets; a non-primitive value (a field from a newer app version) compares as JSON. */
function same(a, b) {
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (a[k] !== b[k] && JSON.stringify(a[k]) !== JSON.stringify(b[k])) return false
  }
  return true
}

/** Record as JSON with sorted top-level keys: devices may build the same record in another key order. */
const canon = (r) => JSON.stringify(Object.fromEntries(Object.entries(r).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))))

/** Item fields mergeItem decides; anything else comes from a newer app version. */
const ITEM_FIELDS = ['id', 'tabId', 'location', 'label', 'category', 'photoId', 'photoAt', 'createdAt', 'movedAt', 'updatedAt']
const extras = (r) => Object.fromEntries(Object.entries(r).filter(([k]) => !ITEM_FIELDS.includes(k)))
const earlier = (x, y) => (x === undefined ? y : y === undefined || x <= y ? x : y)

/**
 * mergeItem with every field decided the same way on every device, so the result never differs
 * from what another device computes (a leftover difference would be pushed back forever):
 * the earlier createdAt, unknown fields from the newer edit (on a tie, the greater JSON).
 */
function mergeSyncItem(a, b) {
  const m = mergeItem(a, b, { breakTies: true })
  const ea = extras(a)
  const eb = extras(b)
  const out = b.updatedAt > a.updatedAt || (b.updatedAt === a.updatedAt && canon(eb) > canon(ea)) ? { ...eb } : { ...ea }
  for (const k of ITEM_FIELDS) if (m[k] !== undefined) out[k] = m[k]
  const createdAt = earlier(a.createdAt, b.createdAt)
  if (createdAt === undefined) delete out.createdAt
  else out.createdAt = createdAt
  return out
}

/** Tabs and categories: the newer updatedAt wins; an exact tie goes to the greater canonical JSON. */
const newerRecord = (cur, v) =>
  v.updatedAt > cur.updatedAt || (v.updatedAt === cur.updatedAt && canon(v) > canon(cur)) ? v : cur

const byId = (list) => new Map(list.map((x) => [x.id, x]))

/** @returns {boolean} whether local state changed */
function applyValue(kind, recs, tombs, v) {
  const cur = recs.get(v.id)
  if (!cur) {
    const t = tombs.get(v.id)
    if (t && !(stamp(kind, v) > t.deletedAt)) return false // deleted after this version: stays dead
    tombs.delete(v.id) // absent, or re-created after the deletion
    recs.set(v.id, v)
    return true
  }
  const merged = kind === 'item' ? mergeSyncItem(cur, v) : newerRecord(cur, v)
  if (same(merged, cur)) return false
  recs.set(v.id, merged)
  return true
}

/** @returns {boolean} whether local state changed */
function applyTombstone(kind, recs, tombs, { id, deletedAt }) {
  const cur = recs.get(id)
  if (cur && deletedAt < stamp(kind, cur)) return false // touched after the deletion: it stays
  const old = tombs.get(id)
  // Kept even without a local record, so a late older version cannot resurrect it.
  if (!old || deletedAt > old.deletedAt) tombs.set(id, { kind, id, deletedAt })
  if (!cur) return false
  recs.delete(id)
  return true
}

/**
 * @param {{tabs:Tab[], categories:Category[], items:Item[], tombstones:Map<string,Tombstone>, photoIds?:Set<string>}} local
 *   photoIds: blobs present on this device (default: every local item's photo)
 * @param {DecodedRecord[]} remote  in pull (seq) order: a later record for an id wins over an earlier one
 * @param {{now:string, defaultTabName:string, deviceId?:string}} opts  deviceId: records by it are not counted in changesBy
 * @returns {SyncPlan}
 */
export function mergeRemote(local, remote, { now, defaultTabName, deviceId }) {
  const orig = { tab: byId(local.tabs), category: byId(local.categories), item: byId(local.items) }
  const state = { tab: new Map(orig.tab), category: new Map(orig.category), item: new Map(orig.item) }
  const tombs = new Map(local.tombstones)
  /** @type {Map<string, {kind:string, id:string, r:DecodedRecord}>} last remote record per kind:id */
  const latest = new Map()
  /** @type {Map<string, number>} */
  const changesBy = new Map()

  for (const r of remote) {
    if (!KINDS.includes(r.kind)) continue // a kind from a newer app version: leave it to that version
    const id = r.tombstone ? r.tombstone.id : r.value.id
    latest.set(`${r.kind}:${id}`, { kind: r.kind, id, r })
    const changed = r.tombstone
      ? applyTombstone(r.kind, state[r.kind], tombs, r.tombstone)
      : applyValue(r.kind, state[r.kind], tombs, r.value)
    if (changed && r.by !== deviceId) changesBy.set(r.by, (changesBy.get(r.by) ?? 0) + 1)
  }

  const pushBack = new Set()
  // Where the server holds something other than the result here, push ours so all devices converge.
  for (const [key, { kind, id, r }] of latest) {
    const cur = state[kind].get(id)
    const differs = r.tombstone ? !!cur : cur ? !same(cur, r.value) : tombs.has(id)
    if (differs) pushBack.add(key)
  }

  // Items are never lost with their tab: they move to the first remaining one (a new one if none is left).
  let home = [...state.tab.values()].sort(byOrder)[0]
  if (!home) {
    home = { id: crypto.randomUUID(), name: defaultTabName, order: 0, createdAt: now, updatedAt: now }
    state.tab.set(home.id, home)
    pushBack.add(`tab:${home.id}`)
  }
  let movedOrphans = 0
  let movedOrphansTab = null
  for (const it of state.item.values()) {
    if (state.tab.has(it.tabId)) continue
    state.item.set(it.id, { ...it, tabId: home.id, updatedAt: now })
    pushBack.add(`item:${it.id}`)
    movedOrphans++
    movedOrphansTab = home.name
  }

  const diff = (kind) => {
    const put = [...state[kind].values()].filter((r) => !orig[kind].has(r.id) || !same(orig[kind].get(r.id), r))
    const del = [...orig[kind].keys()].filter((id) => !state[kind].has(id))
    return [put, del]
  }
  const [tabsPut, tabsDelete] = diff('tab')
  const [categoriesPut, categoriesDelete] = diff('category')
  const [itemsPut, itemsDelete] = diff('item')

  const referenced = new Set([...state.item.values()].map((i) => i.photoId))
  const present = local.photoIds ?? new Set(local.items.map((i) => i.photoId))

  return {
    tabsPut, tabsDelete, categoriesPut, categoriesDelete, itemsPut, itemsDelete,
    photosDelete: [...new Set(local.items.map((i) => i.photoId))].filter((p) => !referenced.has(p)),
    tombstonesPut: [...tombs.values()].filter((t) => local.tombstones.get(t.id)?.deletedAt !== t.deletedAt),
    tombstonesDelete: [...local.tombstones.keys()].filter((id) => !tombs.has(id)),
    pushBack: [...pushBack].map((key) => {
      const i = key.indexOf(':')
      return { kind: key.slice(0, i), id: key.slice(i + 1) }
    }),
    photosNeeded: [...referenced].filter((p) => !present.has(p)),
    movedOrphans,
    movedOrphansTab,
    changesBy,
  }
}
