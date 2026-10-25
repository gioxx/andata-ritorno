// The only module that touches IndexedDB. Every multi-store change runs in one
// transaction so a crash or error never leaves orphan photos or half-imported data.
import { openDB } from 'idb'

/** @typedef {import('./types.js').Tab} Tab */
/** @typedef {import('./types.js').Item} Item */
/** @typedef {import('./types.js').Photo} Photo */
/** @typedef {import('./types.js').Category} Category */
/** @typedef {import('./types.js').ImportPlan} ImportPlan */

let versionChangeHandler = null

/** @param {(() => void)|null} fn called after the connection closed on versionchange */
export function setVersionChangeHandler(fn) {
  versionChangeHandler = fn
}

/** @param {string} [name] */
export async function openDb(name = 'ar') {
  return openDB(name, 2, {
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
  tabs.sort((a, b) => a.order - b.order)
  categories.sort((a, b) => a.order - b.order)
  return { tabs, items, categories }
}

/** @param {Tab} tab */
export async function putTab(db, tab) {
  await db.put('tabs', tab)
}

/** @param {Category} cat */
export async function putCategory(db, cat) {
  await db.put('categories', cat)
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
  await withTx(db, ['tabs'], (tx, track) => {
    for (const t of tabs) track(tx.store.put(t))
  })
}

/** @param {Category[]} cats  One tx, so a reorder is never half-saved. */
export async function putCategories(db, cats) {
  await withTx(db, ['categories'], (tx, track) => {
    for (const c of cats) track(tx.store.put(c))
  })
}

/** Delete a category; its items stay, uncategorised, with `updatedAt = now` so merges see the edit. */
export async function deleteCategory(db, id, now) {
  await withTx(db, ['categories', 'items'], async (tx) => {
    const items = await tx.objectStore('items').index('category').getAll(id)
    for (const it of items) {
      const { category: _gone, ...rest } = it
      await tx.objectStore('items').put({ ...rest, updatedAt: now })
    }
    await tx.objectStore('categories').delete(id)
  })
}

export async function deleteTab(db, tabId) {
  await withTx(db, ['tabs', 'items', 'photos'], async (tx) => {
    // Checked inside the tx so two concurrent deletes cannot both pass.
    if ((await tx.objectStore('tabs').count()) <= 1) throw new Error('last-tab')
    const items = await tx.objectStore('items').index('tabId').getAll(tabId)
    for (const it of items) {
      await tx.objectStore('photos').delete(it.photoId)
      await tx.objectStore('items').delete(it.id)
    }
    await tx.objectStore('tabs').delete(tabId)
  })
}

/**
 * @param {Item[]} items
 * @param {Photo[]} photos
 */
export async function addItems(db, items, photos) {
  await withTx(db, ['items', 'photos'], (tx, track) => {
    for (const p of photos) track(tx.objectStore('photos').put(p))
    for (const it of items) track(tx.objectStore('items').put(it))
  })
}

export async function moveItems(db, ids, location, now) {
  await patchItems(db, ids, (it) => ({ ...it, location, movedAt: now }))
}

const EDITABLE = ['label', 'tabId', 'category']

/** @param {{label?:string, tabId?:string, category?:string}} patch  Other keys are ignored. */
export async function updateItem(db, id, patch, now) {
  const clean = {}
  for (const k of EDITABLE) if (k in patch) clean[k] = patch[k]
  await patchItems(db, [id], (it) => ({ ...it, ...clean, updatedAt: now }))
}

/** @param {Photo} photo */
export async function replacePhoto(db, itemId, photo, now) {
  await withTx(db, ['items', 'photos'], async (tx) => {
    const it = await tx.objectStore('items').get(itemId)
    if (!it) throw new Error('not-found')
    await tx.objectStore('photos').put(photo)
    if (it.photoId !== photo.id) await tx.objectStore('photos').delete(it.photoId)
    await tx.objectStore('items').put({ ...it, photoId: photo.id, updatedAt: now })
  })
}

export async function deleteItems(db, ids) {
  await withTx(db, ['items', 'photos'], async (tx) => {
    for (const id of ids) {
      const it = await tx.objectStore('items').get(id)
      if (!it) continue
      await tx.objectStore('photos').delete(it.photoId)
      await tx.objectStore('items').delete(id)
    }
  })
}

/** @returns {Promise<Blob|undefined>} */
export async function getPhoto(db, id) {
  return (await db.get('photos', id))?.blob
}

export const getMeta = (db, key) => db.get('meta', key)
export const setMeta = async (db, key, value) => {
  await db.put('meta', value, key)
}

/** @param {ImportPlan} plan  One tx over everything (incl. meta): all-or-nothing. */
export async function applyPlan(db, plan) {
  await withTx(db, ['tabs', 'categories', 'items', 'photos', 'meta'], (tx, track) => {
    for (const t of plan.tabsPut) track(tx.objectStore('tabs').put(t))
    for (const c of plan.categoriesPut ?? []) track(tx.objectStore('categories').put(c))
    for (const it of plan.itemsPut) track(tx.objectStore('items').put(it))
    // Dimensions are unknown for imported blobs; 0 means "not measured".
    for (const [id, blob] of plan.photosPut) track(tx.objectStore('photos').put({ id, blob, width: 0, height: 0 }))
    for (const id of plan.photosDelete) track(tx.objectStore('photos').delete(id))
    for (const [k, v] of plan.metaPut ?? []) track(tx.objectStore('meta').put(v, k))
  })
}

async function patchItems(db, ids, fn) {
  await withTx(db, ['items'], async (tx) => {
    for (const id of ids) {
      const it = await tx.store.get(id)
      if (it) await tx.store.put(fn(it))
    }
  })
}
