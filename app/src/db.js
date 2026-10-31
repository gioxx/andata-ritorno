// The only module that touches IndexedDB. Every multi-store change runs in one
// transaction so a crash or error never leaves orphan photos or half-imported data.
import { openDB } from 'idb'
import { byOrder } from './order.js'

/** @typedef {import('./types.js').Tab} Tab */
/** @typedef {import('./types.js').Item} Item */
/** @typedef {import('./types.js').Photo} Photo */
/** @typedef {import('./types.js').Category} Category */
/** @typedef {import('./types.js').ImportPlan} ImportPlan */
/** @typedef {import('./types.js').Tombstone} Tombstone */

let versionChangeHandler = null

/** @param {(() => void)|null} fn called after the connection closed on versionchange */
export function setVersionChangeHandler(fn) {
  versionChangeHandler = fn
}

/**
 * @param {string} [name]
 * @param {{ onBlocked?: () => void }} [opts] called when an older open tab keeps the upgrade
 *   waiting; the returned promise still resolves once that tab closes its connection.
 */
export async function openDb(name = 'ar', { onBlocked } = {}) {
  return openDB(name, 3, {
    blocked() { onBlocked?.() },
    // Additive steps only: existing v1 records (real user data) are never touched.
    upgrade(db, oldVersion, _newVersion, tx) {
      if (oldVersion < 1) {
        db.createObjectStore('tabs', { keyPath: 'id' })
        db.createObjectStore('items', { keyPath: 'id' }).createIndex('tabId', 'tabId')
        db.createObjectStore('photos', { keyPath: 'id' })
        db.createObjectStore('meta')
      }
      if (oldVersion < 2) {
        db.createObjectStore('categories', { keyPath: 'id' })
        tx.objectStore('items').createIndex('category', 'category')
      }
      if (oldVersion < 3) {
        // Sync bookkeeping: what changed since the last push, and what was deleted.
        db.createObjectStore('outbox')
        db.createObjectStore('tombstones', { keyPath: 'id' })
      }
    },
  }).then((db) => {
    db.addEventListener('versionchange', () => {
      db.close()
      versionChangeHandler?.()
    })
    return db
  })
}

/** @returns {Promise<{tabs:Tab[], items:Item[], categories:Category[]}>} */
export async function loadAll(db) {
  const [tabs, items, categories] = await Promise.all([
    db.getAll('tabs'), db.getAll('items'), db.getAll('categories'),
  ])
  tabs.sort(byOrder)
  categories.sort(byOrder)
  return { tabs, items, categories }
}

let tracking = false

/** When on, every write also records outbox entries (and tombstones for deletes) in its own tx. */
export function setSyncTracking(on) {
  tracking = !!on
}

/** Stores a write tx must open: the outbox joins in when tracking. */
const withOutbox = (stores) => (tracking ? [...stores, 'outbox'] : stores)

// Every mark gets a fresh `at`, so clearOutbox can tell an entry re-marked during a push from the
// one that was pushed (time + counter: unique across reloads, where a bare counter restarts).
let marks = 0
const outboxEntry = (kind, id) => ({ kind, id, at: `${new Date().toISOString()}#${++marks}` })
const putOutbox = (tx, track, kind, id) => track(tx.objectStore('outbox').put(outboxEntry(kind, id), `${kind}:${id}`))

function markDirty(tx, track, kind, id) {
  if (tracking) putOutbox(tx, track, kind, id)
}

/** Delete bookkeeping; the caller must have opened 'tombstones' (tracking only). */
function markDeleted(tx, track, kind, id, now) {
  track(tx.objectStore('tombstones').put({ kind, id, deletedAt: now }))
  markDirty(tx, track, kind, id)
}

/** @typedef {{kind:string, id:string, at:string}} OutboxEntry */

/** @returns {Promise<OutboxEntry[]>} */
export const readOutbox = (db) => db.getAll('outbox')

/**
 * Drop pushed entries, each only if it was not marked again since it was read: an edit made
 * while the push was in flight keeps its entry and goes out next time.
 * @param {OutboxEntry[]} entries  as returned by readOutbox
 */
export async function clearOutbox(db, entries) {
  await withTx(db, ['outbox'], async (tx) => {
    for (const e of entries) {
      const key = `${e.kind}:${e.id}`
      if ((await tx.store.get(key))?.at === e.at) await tx.store.delete(key)
    }
  })
}

/** Queue one record for upload, tracking or not (e.g. the family's recovery kit). */
export async function queueOutbox(db, kind, id) {
  await withTx(db, ['outbox'], (tx, track) => putOutbox(tx, track, kind, id))
}

/**
 * Queue every local tab, category and item for upload (a device entering a family). With
 * `skipEmptyTabs`, tabs holding no item are left out of the queue.
 * @returns {Promise<string[]>} ids of the tabs left out
 */
export async function markAllDirty(db, { skipEmptyTabs = false } = {}) {
  const skipped = []
  await withTx(db, ['tabs', 'categories', 'items', 'outbox'], async (tx, track) => {
    const used = new Set((await tx.objectStore('items').getAll()).map((it) => it.tabId))
    for (const [store, kind] of [['tabs', 'tab'], ['categories', 'category'], ['items', 'item']]) {
      for (const id of await tx.objectStore(store).getAllKeys()) {
        if (skipEmptyTabs && kind === 'tab' && !used.has(id)) skipped.push(id)
        else putOutbox(tx, track, kind, id)
      }
    }
  })
  return skipped
}

/**
 * Delete these tabs if they are still empty and not the last tab: no tombstone, no outbox entry
 * (they never reached the server). A tab that got items meanwhile, or is the last one, is kept and queued for upload.
 * @returns {Promise<number>} how many were deleted
 */
export async function dropEmptyTabs(db, ids) {
  let dropped = 0
  await withTx(db, ['tabs', 'items', 'outbox'], async (tx, track) => {
    for (const id of ids) {
      if (!(await tx.objectStore('tabs').get(id))) continue
      const keep = (await tx.objectStore('items').index('tabId').count(id)) || (await tx.objectStore('tabs').count()) <= 1
      if (keep) {
        putOutbox(tx, track, 'tab', id)
      } else {
        await tx.objectStore('tabs').delete(id)
        await tx.objectStore('outbox').delete(`tab:${id}`)
        dropped++
      }
    }
  })
  return dropped
}

/** @returns {Promise<Set<string>>} ids of the photo blobs on this device */
export async function getPhotoIds(db) {
  return new Set(await db.getAllKeys('photos'))
}

/**
 * Store a downloaded photo only if `itemId` still points at it (the item may have been deleted
 * or given another photo while it downloaded), so no unreferenced blob is left behind.
 * @param {import('./types.js').Photo} photo
 * @returns {Promise<boolean>} whether it was stored
 */
export async function putSyncedPhoto(db, itemId, photo) {
  let stored = false
  await withTx(db, ['items', 'photos'], async (tx) => {
    if ((await tx.objectStore('items').get(itemId))?.photoId !== photo.id) return
    await tx.objectStore('photos').put(photo)
    stored = true
  })
  return stored
}

export const deleteMeta = async (db, key) => {
  await db.delete('meta', key)
}

/** @returns {Promise<Map<string, Tombstone>>} by id */
export async function getTombstones(db) {
  return new Map((await db.getAll('tombstones')).map((t) => [t.id, t]))
}

/** @param {Tombstone[]} list */
export async function putTombstones(db, list) {
  await withTx(db, ['tombstones'], (tx, track) => {
    for (const t of list) track(tx.store.put(t))
  })
}

export async function clearSyncStores(db) {
  await withTx(db, ['outbox', 'tombstones'], (tx, track) => {
    track(tx.objectStore('outbox').clear())
    track(tx.objectStore('tombstones').clear())
  })
}

/** Empty the wardrobe and its sync bookkeeping; other meta stays, the unsaved counter resets. */
export async function clearWardrobe(db) {
  const data = ['tabs', 'categories', 'items', 'photos', 'outbox', 'tombstones']
  await withTx(db, [...data, 'meta'], (tx, track) => {
    for (const n of data) track(tx.objectStore(n).clear())
    track(tx.objectStore('meta').put(0, 'unsavedCount'))
  })
}

/** @param {Tab} tab */
export async function putTab(db, tab) {
  await withTx(db, withOutbox(['tabs']), (tx, track) => {
    track(tx.objectStore('tabs').put(tab))
    markDirty(tx, track, 'tab', tab.id)
  })
}

/** @param {Category} cat */
export async function putCategory(db, cat) {
  await withTx(db, withOutbox(['categories']), (tx, track) => {
    track(tx.objectStore('categories').put(cat))
    markDirty(tx, track, 'category', cat.id)
  })
}

/**
 * Run `fn(tx, track)` in one readwrite tx. `track` registers fire-and-forget
 * requests; if anything fails (sync throw or async request error such as quota)
 * the tx is aborted and the caller gets exactly one rejection, the original error,
 * with no unhandled rejections left behind.
 */
async function withTx(db, stores, fn) {
  const tx = db.transaction(stores, 'readwrite')
  const pending = []
  const track = (p) => { pending.push(p); return p }
  let first
  const record = (e) => { first ??= e }
  try {
    await fn(tx, track)
  } catch (e) {
    record(e)
    try { tx.abort() } catch { /* already finished */ }
  }
  // Settle every request and tx.done; the first error that surfaced wins.
  const results = await Promise.allSettled([...pending, tx.done])
  for (const r of results) if (r.status === 'rejected') record(r.reason)
  if (first) throw first
}

/** @param {Tab[]} tabs  One tx, so a reorder is never half-saved. */
export async function putTabs(db, tabs) {
  await withTx(db, withOutbox(['tabs']), (tx, track) => {
    for (const t of tabs) {
      track(tx.objectStore('tabs').put(t))
      markDirty(tx, track, 'tab', t.id)
    }
  })
}

/** @param {Category[]} cats  One tx, so a reorder is never half-saved. */
export async function putCategories(db, cats) {
  await withTx(db, withOutbox(['categories']), (tx, track) => {
    for (const c of cats) {
      track(tx.objectStore('categories').put(c))
      markDirty(tx, track, 'category', c.id)
    }
  })
}

/**
 * Delete a category. Untracked: its items stay, uncategorised, with `updatedAt = now` so merges
 * see the edit. Tracked: a tombstone instead, items untouched (each device clears dangling
 * categories itself when it applies the deletion).
 */
export async function deleteCategory(db, id, now) {
  if (tracking) {
    await withTx(db, ['categories', 'tombstones', 'outbox'], (tx, track) => {
      track(tx.objectStore('categories').delete(id))
      markDeleted(tx, track, 'category', id, now)
    })
    return
  }
  await withTx(db, ['categories', 'items'], async (tx) => {
    const items = await tx.objectStore('items').index('category').getAll(id)
    for (const it of items) {
      const { category: _gone, ...rest } = it
      await tx.objectStore('items').put({ ...rest, updatedAt: now })
    }
    await tx.objectStore('categories').delete(id)
  })
}

export async function deleteTab(db, tabId, now) {
  await withTx(db, withOutbox(['tabs', 'items', 'photos', ...(tracking ? ['tombstones'] : [])]), async (tx, track) => {
    // Checked inside the tx so two concurrent deletes cannot both pass.
    if ((await tx.objectStore('tabs').count()) <= 1) throw new Error('last-tab')
    const items = await tx.objectStore('items').index('tabId').getAll(tabId)
    for (const it of items) {
      await tx.objectStore('photos').delete(it.photoId)
      await tx.objectStore('items').delete(it.id)
      if (tracking) markDeleted(tx, track, 'item', it.id, now)
    }
    await tx.objectStore('tabs').delete(tabId)
    if (tracking) markDeleted(tx, track, 'tab', tabId, now)
  })
}

/**
 * @param {Item[]} items
 * @param {Photo[]} photos
 */
export async function addItems(db, items, photos) {
  await withTx(db, withOutbox(['items', 'photos']), (tx, track) => {
    for (const p of photos) track(tx.objectStore('photos').put(p))
    for (const it of items) {
      track(tx.objectStore('items').put(it))
      markDirty(tx, track, 'item', it.id)
    }
  })
}

export async function moveItems(db, ids, location, now) {
  await patchItems(db, ids, (it) => ({ ...it, location, movedAt: now }))
}

/** One category on many items in one transaction; an empty/null category clears it (absent key). */
export async function setItemsCategory(db, ids, category, now) {
  await patchItems(db, ids, (it) => {
    const next = { ...it, category, updatedAt: now }
    if (!category) delete next.category
    return next
  })
}

/** The only item fields an edit may change. */
export const EDITABLE_FIELDS = ['label', 'tabId', 'category']

/** @param {{label?:string, tabId?:string, category?:string|null}} patch  Other keys are ignored; a null/undefined category clears it. */
export async function updateItem(db, id, patch, now) {
  const clean = {}
  for (const k of EDITABLE_FIELDS) if (k in patch) clean[k] = patch[k]
  await patchItems(db, [id], (it) => {
    const next = { ...it, ...clean, updatedAt: now }
    // Never store an explicit undefined/null: "no category" is an absent key.
    if (next.category == null) delete next.category
    return next
  })
}

/** @param {Photo} photo */
export async function replacePhoto(db, itemId, photo, now) {
  await withTx(db, withOutbox(['items', 'photos']), async (tx, track) => {
    const it = await tx.objectStore('items').get(itemId)
    if (!it) throw new Error('not-found')
    await tx.objectStore('photos').put(photo)
    if (it.photoId !== photo.id) await tx.objectStore('photos').delete(it.photoId)
    await tx.objectStore('items').put({ ...it, photoId: photo.id, photoAt: now, updatedAt: now })
    markDirty(tx, track, 'item', itemId)
  })
}

export async function deleteItems(db, ids, now) {
  await withTx(db, withOutbox(['items', 'photos', ...(tracking ? ['tombstones'] : [])]), async (tx, track) => {
    for (const id of ids) {
      const it = await tx.objectStore('items').get(id)
      if (!it) continue
      await tx.objectStore('photos').delete(it.photoId)
      await tx.objectStore('items').delete(id)
      if (tracking) markDeleted(tx, track, 'item', id, now)
    }
  })
}

/** @returns {Promise<Blob|undefined>} */
export async function getPhoto(db, id) {
  return (await db.get('photos', id))?.blob
}

/** @returns {Promise<import('./types.js').Photo|undefined>} blob with its dimensions */
export const getPhotoRecord = (db, id) => db.get('photos', id)

export const getMeta = (db, key) => db.get('meta', key)
export const setMeta = async (db, key, value) => {
  await db.put('meta', value, key)
}

/**
 * @param {ImportPlan} plan  One tx over everything (incl. meta): all-or-nothing.
 * While tracking, an import is an explicit restore: any put whose id has a tombstone is revived
 * (tombstone dropped, `updatedAt = now` so it beats that tombstone on other devices).
 */
export async function applyPlan(db, plan, now = new Date().toISOString()) {
  const stores = ['tabs', 'categories', 'items', 'photos', 'meta', ...(tracking ? ['tombstones'] : [])]
  await withTx(db, withOutbox(stores), async (tx, track) => {
    /** @type {(kind:string, x:{id:string, updatedAt:string}) => {id:string, updatedAt:string}} */
    let put = (_kind, x) => x
    if (tracking) {
      const dead = new Set((await tx.objectStore('tombstones').getAllKeys()))
      put = (kind, x) => {
        markDirty(tx, track, kind, x.id)
        if (!dead.has(x.id)) return x
        track(tx.objectStore('tombstones').delete(x.id))
        return { ...x, updatedAt: now }
      }
    }
    for (const t of plan.tabsPut) track(tx.objectStore('tabs').put(put('tab', t)))
    for (const c of plan.categoriesPut ?? []) track(tx.objectStore('categories').put(put('category', c)))
    for (const it of plan.itemsPut) track(tx.objectStore('items').put(put('item', it)))
    // Dimensions are unknown for imported blobs; 0 means "not measured".
    for (const [id, blob] of plan.photosPut) track(tx.objectStore('photos').put({ id, blob, width: 0, height: 0 }))
    for (const id of plan.photosDelete) track(tx.objectStore('photos').delete(id))
    for (const [k, v] of plan.metaPut ?? []) track(tx.objectStore('meta').put(v, k))
  })
}

/**
 * @param {import('./types.js').SyncPlan} plan  from sync/merge.js, all-or-nothing. Records taken
 * from the server are not queued for upload again (writes here bypass markDirty); only
 * `pushBack` joins the outbox, next to entries already waiting.
 */
export async function applySyncPlan(db, plan) {
  const stores = ['tabs', 'categories', 'items', 'photos', 'tombstones', 'outbox']
  await withTx(db, stores, (tx, track) => {
    const st = (n) => tx.objectStore(n)
    for (const id of plan.tabsDelete) track(st('tabs').delete(id))
    for (const id of plan.categoriesDelete) track(st('categories').delete(id))
    for (const id of plan.itemsDelete) track(st('items').delete(id))
    for (const id of plan.photosDelete) track(st('photos').delete(id))
    for (const id of plan.tombstonesDelete) track(st('tombstones').delete(id))
    for (const t of plan.tabsPut) track(st('tabs').put(t))
    for (const c of plan.categoriesPut) track(st('categories').put(c))
    for (const it of plan.itemsPut) track(st('items').put(it))
    for (const t of plan.tombstonesPut) track(st('tombstones').put(t))
    for (const { kind, id } of plan.pushBack) putOutbox(tx, track, kind, id)
  })
}

async function patchItems(db, ids, fn) {
  await withTx(db, withOutbox(['items']), async (tx, track) => {
    for (const id of ids) {
      const it = await tx.objectStore('items').get(id)
      if (!it) continue
      await tx.objectStore('items').put(fn(it))
      markDirty(tx, track, 'item', id)
    }
  })
}
