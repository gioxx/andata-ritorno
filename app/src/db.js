// The only module that touches IndexedDB. Every multi-store change runs in one
// transaction so a crash or error never leaves orphan photos or half-imported data.
import { openDB } from 'idb'

/** @typedef {import('./types.js').Tab} Tab */
/** @typedef {import('./types.js').Item} Item */
/** @typedef {import('./types.js').Photo} Photo */
/** @typedef {import('./types.js').ImportPlan} ImportPlan */

let versionChangeHandler = null

/** @param {(() => void)|null} fn called after the connection closed on versionchange */
export function setVersionChangeHandler(fn) {
  versionChangeHandler = fn
}

/** @param {string} [name] */
export async function openDb(name = 'ar') {
  return openDB(name, 1, {
    upgrade(db) {
      db.createObjectStore('tabs', { keyPath: 'id' })
      db.createObjectStore('items', { keyPath: 'id' }).createIndex('tabId', 'tabId')
      db.createObjectStore('photos', { keyPath: 'id' })
      db.createObjectStore('meta')
    },
  }).then((db) => {
    db.addEventListener('versionchange', () => {
      db.close()
      versionChangeHandler?.()
    })
    return db
  })
}

/** @returns {Promise<{tabs:Tab[], items:Item[]}>} */
export async function loadAll(db) {
  const [tabs, items] = await Promise.all([db.getAll('tabs'), db.getAll('items')])
  tabs.sort((a, b) => a.order - b.order)
  return { tabs, items }
}

/** @param {Tab} tab */
export async function putTab(db, tab) {
  await db.put('tabs', tab)
}

export async function deleteTab(db, tabId) {
  const pending = []
  const tx = db.transaction(['tabs', 'items', 'photos'], 'readwrite')
  try {
    // Checked inside the tx so two concurrent deletes cannot both pass.
    if ((await tx.objectStore('tabs').count()) <= 1) throw new Error('last-tab')
    const items = await tx.objectStore('items').index('tabId').getAll(tabId)
    for (const it of items) {
      await tx.objectStore('photos').delete(it.photoId)
      await tx.objectStore('items').delete(it.id)
    }
    await tx.objectStore('tabs').delete(tabId)
  } catch (e) {
    await fail(tx, pending, e)
  }
  await tx.done
}

/**
 * @param {Item[]} items
 * @param {Photo[]} photos
 */
export async function addItems(db, items, photos) {
  const pending = []
  const tx = db.transaction(['items', 'photos'], 'readwrite')
  try {
    for (const p of photos) pending.push(tx.objectStore('photos').put(p))
    for (const it of items) pending.push(tx.objectStore('items').put(it))
  } catch (e) {
    await fail(tx, pending, e)
  }
  await tx.done
}

export async function moveItems(db, ids, location, now) {
  await patchItems(db, ids, (it) => ({ ...it, location, movedAt: now }))
}

/** @param {{label?:string, tabId?:string, category?:string}} patch */
export async function updateItem(db, id, patch, now) {
  await patchItems(db, [id], (it) => ({ ...it, ...patch, updatedAt: now }))
}

/** @param {Photo} photo */
export async function replacePhoto(db, itemId, photo, now) {
  const pending = []
  const tx = db.transaction(['items', 'photos'], 'readwrite')
  try {
    const it = await tx.objectStore('items').get(itemId)
    if (!it) throw new Error('not-found')
    await tx.objectStore('photos').put(photo)
    if (it.photoId !== photo.id) await tx.objectStore('photos').delete(it.photoId)
    await tx.objectStore('items').put({ ...it, photoId: photo.id, updatedAt: now })
  } catch (e) {
    await fail(tx, pending, e)
  }
  await tx.done
}

export async function deleteItems(db, ids) {
  const pending = []
  const tx = db.transaction(['items', 'photos'], 'readwrite')
  try {
    for (const id of ids) {
      const it = await tx.objectStore('items').get(id)
      if (!it) continue
      await tx.objectStore('photos').delete(it.photoId)
      await tx.objectStore('items').delete(id)
    }
  } catch (e) {
    await fail(tx, pending, e)
  }
  await tx.done
}

/** @returns {Promise<Blob|undefined>} */
export async function getPhoto(db, id) {
  return (await db.get('photos', id))?.blob
}

export const getMeta = (db, key) => db.get('meta', key)
export const setMeta = async (db, key, value) => {
  await db.put('meta', value, key)
}

/** @param {ImportPlan} plan  One tx over everything: all-or-nothing. */
export async function applyPlan(db, plan) {
  const pending = []
  const tx = db.transaction(['tabs', 'items', 'photos', 'meta'], 'readwrite')
  try {
    for (const t of plan.tabsPut) pending.push(tx.objectStore('tabs').put(t))
    for (const it of plan.itemsPut) pending.push(tx.objectStore('items').put(it))
    // Dimensions are unknown for imported blobs; 0 means "not measured".
    for (const [id, blob] of plan.photosPut) pending.push(tx.objectStore('photos').put({ id, blob, width: 0, height: 0 }))
    for (const id of plan.photosDelete) pending.push(tx.objectStore('photos').delete(id))
  } catch (e) {
    await fail(tx, pending, e)
  }
  await tx.done
}

async function patchItems(db, ids, fn) {
  const pending = []
  const tx = db.transaction('items', 'readwrite')
  try {
    for (const id of ids) {
      const it = await tx.store.get(id)
      if (it) await tx.store.put(fn(it))
    }
  } catch (e) {
    await fail(tx, pending, e)
  }
  await tx.done
}

// Abort the tx and swallow the AbortError of requests still in flight, so only the
// original error reaches the caller (and nothing is left as an unhandled rejection).
async function fail(tx, pending, err) {
  try { tx.abort() } catch { /* already finished */ }
  pending.forEach((p) => p.catch(() => {}))
  await tx.done.catch(() => {})
  throw err
}
