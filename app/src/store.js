// In-memory state mirrored from IndexedDB. Every action writes via db.js first,
// then updates memory and notifies, so the UI never shows something that isn't saved.
import { getPhoto, loadAll, moveItems, deleteItems, addItems, getMeta, setMeta, putTab, putTabs, deleteTab, updateItem, replacePhoto, putCategory, putCategories, deleteCategory, setItemsCategory, EDITABLE_FIELDS } from './db.js'
import { compress } from './photos.js'
import { rotatePhoto } from './rotate.js'
import { missingDefaults, categoryName } from './categories.js'
import { t } from './i18n.js'
import { visibleItems } from './ui/filter.js'

/** @typedef {import('./types.js').Tab} Tab */
/** @typedef {import('./types.js').Item} Item */
/** @typedef {import('./types.js').Category} Category */

export const store = {
  db: /** @type {any} */ (null),
  /** @type {Tab[]} */ tabs: [],
  /** @type {Category[]} */ categories: [],
  /** @type {Item[]} */ items: [],
  /** @type {string|null} */ currentTabId: null,
  /** @type {Set<string>} */ selected: new Set(),
  /** Category ids of the active tag filter (empty = all); session only, never persisted. @type {Set<string>} */ filter: new Set(),
  unsaved: 0,
}

const listeners = new Set()
/** @param {() => void} fn @returns {() => void} unsubscribe */
export function subscribe(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
export function notify() {
  for (const fn of [...listeners]) fn()
}

export async function load(db) {
  const { tabs, items, categories } = await loadAll(db)
  store.db = db
  store.tabs = tabs
  store.categories = categories
  store.items = items
  store.unsaved = (await getMeta(db, 'unsavedCount')) ?? 0
  store.selected = new Set()
  if (!tabs.some((t) => t.id === store.currentTabId)) store.currentTabId = tabs[0]?.id ?? null
  settle()
  notify()
}

/**
 * Keep filter and selection coherent after any change: the filter only holds categories
 * still used in the current tab (else the screen could be empty with no pill to clear),
 * and the selection only holds visible items.
 */
function settle() {
  const used = new Set(store.items.filter((i) => i.tabId === store.currentTabId && i.category).map((i) => i.category))
  for (const id of [...store.filter]) if (!used.has(id)) store.filter.delete(id)
  if (!store.filter.size) return
  const shown = new Set(visibleItems(store.items, store.filter).map((i) => i.id))
  for (const id of [...store.selected]) if (!shown.has(id)) store.selected.delete(id)
}

export function toggleFilter(id) {
  if (!store.filter.delete(id)) store.filter.add(id)
  settle()
  notify()
}

export function clearFilter() {
  store.filter.clear()
  notify()
}

export function setCurrentTab(id) {
  if (id === store.currentTabId) return
  store.currentTabId = id
  store.selected.clear()
  store.filter.clear()
  notify()
}

export function selectToggle(id) {
  if (!store.selected.delete(id)) store.selected.add(id)
  notify()
}

/** Select every visible (filter-respecting) item of the current tab in `location`; if all are already selected, deselect them. */
export function selectSection(location) {
  const ids = visibleItems(store.items.filter((i) => i.tabId === store.currentTabId), store.filter)
    .filter((i) => i.location === location)
    .map((i) => i.id)
  const allSelected = ids.length > 0 && ids.every((id) => store.selected.has(id))
  for (const id of ids) allSelected ? store.selected.delete(id) : store.selected.add(id)
  notify()
}

export function clearSelection() {
  store.selected.clear()
  notify()
}

// Serialize every mutation: read-await-write sequences (counter bumps, moves) would
// otherwise interleave on a double tap and lose updates.
let chain = Promise.resolve()
let inFlight = 0
function queue(fn) {
  inFlight++
  const run = chain.then(fn)
  chain = run.catch(() => {}) // a failed action must not block the next one
  chain.then(() => { inFlight-- })
  return run
}

/** True while any queued mutation (save, import, export, wipe) is pending or running. */
export const isBusy = () => inFlight > 0

/**
 * Run `fn` alone in the mutation queue: it starts after every pending mutation and later
 * ones wait for it (an import plans from a DB snapshot that must not change under it).
 * `fn` must use db.js functions and load() only: awaiting a store action from inside
 * would wait for its own slot and never finish. Not awaited, such an action simply runs after.
 * @template T @param {() => Promise<T>} fn @returns {Promise<T>}
 */
export function runExclusive(fn) {
  return queue(fn)
}

async function bump(n) {
  const next = store.unsaved + n
  await setMeta(store.db, 'unsavedCount', next)
  store.unsaved = next
}

/** Take the current selection and clear it right away, so a fast second tap finds nothing. */
function takeSelection() {
  const ids = [...store.selected]
  store.selected.clear()
  return ids
}

/** Put back what a failed action took, so the user can retry. */
function restoreSelection(ids) {
  for (const id of ids) store.selected.add(id)
  notify()
}

export function move(location) {
  const ids = takeSelection()
  if (!ids.length) return Promise.resolve()
  return queue(async () => {
    try {
      const now = new Date().toISOString()
      await moveItems(store.db, ids, location, now)
      const set = new Set(ids)
      for (const it of store.items) if (set.has(it.id)) { it.location = location; it.movedAt = now }
      await bump(ids.length)
      notify()
    } catch (e) { restoreSelection(ids); throw e }
  })
}

/**
 * Give every selected item one category ('' or null clears it) as one action.
 * Items that already have it are left alone and not counted as changes.
 * @param {string|null} category
 */
export function categorizeSelected(category) {
  const ids = takeSelection()
  if (!ids.length) return Promise.resolve()
  return queue(async () => {
    try {
      if (category && !store.categories.some((c) => c.id === category)) throw new Error('not-found')
      const set = new Set(ids)
      const changed = store.items.filter((i) => set.has(i.id) && (i.category ?? '') !== (category || ''))
      if (changed.length) {
        const now = new Date().toISOString()
        await setItemsCategory(store.db, changed.map((i) => i.id), category, now)
        for (const it of changed) {
          if (category) it.category = category
          else delete it.category
          it.updatedAt = now
        }
        await bump(changed.length)
      }
      settle()
      notify()
    } catch (e) { restoreSelection(ids); throw e }
  })
}

export function deleteSelected() {
  const ids = takeSelection()
  if (!ids.length) return Promise.resolve()
  return queue(async () => {
    try {
      await deleteItems(store.db, ids)
      const set = new Set(ids)
      store.items = store.items.filter((i) => !set.has(i.id))
      await bump(ids.length)
      settle()
      notify()
    } catch (e) { restoreSelection(ids); throw e }
  })
}

/**
 * Add one item per photo to the current tab. Rejects (e.g. QuotaExceededError) with
 * nothing added: addItems writes photos and items in one transaction.
 * @param {import('./types.js').Photo[]} photos
 * @param {{location: 'school'|'home', label: string, category?: string}} opts
 */
export function addPhotos(photos, { location, label, category }) {
  const tabId = store.currentTabId
  return queue(async () => {
    if (category && !store.categories.some((c) => c.id === category)) throw new Error('not-found')
    const now = new Date().toISOString()
    const items = photos.map((photo) => ({
      id: crypto.randomUUID(), tabId, location, label, photoId: photo.id,
      ...(category ? { category } : {}),
      createdAt: now, movedAt: now, updatedAt: now,
    }))
    await addItems(store.db, items, photos)
    store.items.push(...items)
    await bump(items.length)
    notify()
  })
}

/**
 * Edit label / tab / category (anything else is ignored) and optionally replace the photo,
 * as ONE change. Changes updatedAt, never movedAt. Nothing changed = nothing written.
 * The replaced blob is deleted in replacePhoto's transaction; the old object URL is dropped
 * by the next render (it revokes URLs of photos no longer in use).
 * @param {string} id
 * @param {{label?:string, tabId?:string, category?:string|null}} patch (category null clears it)
 * @param {import('./types.js').Photo|null} [photo] already compressed, see prepareReplacement
 */
export function editItem(id, patch, photo = null) {
  return queue(() => applyEdit(id, patch, photo))
}

/**
 * editItem with an optional rotation, all inside ONE queue slot: the source blob is read and
 * rotated after earlier saves have settled, so quick successive saves never lose a turn.
 * The field edits (and a picked photo, unrotated) are saved even if the rotation fails.
 * @param {number} turns quarter turns clockwise (0 = none)
 * @param {import('./types.js').Photo|null} pendingPhoto a newly picked photo; it is the one rotated
 * @param {Function} [encode] test seam for rotatePhoto
 * @returns {Promise<Error|null>} the rotation error, if any (the rest was still saved)
 */
export function rotateAndEdit(id, patch, turns, pendingPhoto = null, encode) {
  return queue(async () => {
    let photo = pendingPhoto
    let rotationError = null
    if (turns) {
      try {
        const it = store.items.find((i) => i.id === id)
        if (!it) throw new Error('not-found')
        const src = pendingPhoto?.blob ?? (await getPhoto(store.db, it.photoId))
        if (!src) throw new Error('rotate-missing')
        photo = await rotatePhoto(src, turns, encode)
      } catch (e) {
        rotationError = e
        if (e?.message === 'not-found') throw e
      }
    }
    await applyEdit(id, patch, photo)
    return rotationError
  })
}

async function applyEdit(id, patch, photo) {
  {
    const it = store.items.find((i) => i.id === id)
    if (!it) throw new Error('not-found')
    const clean = {}
    for (const k of EDITABLE_FIELDS) if (patch[k] !== undefined) clean[k] = patch[k]
    if (clean.label !== undefined) clean.label = String(clean.label).trim()
    if (clean.tabId !== undefined && !store.tabs.some((t) => t.id === clean.tabId)) throw new Error('not-found')
    if (clean.category && !store.categories.some((c) => c.id === clean.category)) throw new Error('not-found')
    for (const k of Object.keys(clean)) if ((clean[k] ?? undefined) === (it[k] ?? (k === 'label' ? '' : undefined))) delete clean[k]
    if (!Object.keys(clean).length && !photo) return
    const now = new Date().toISOString()
    if (photo) {
      await replacePhoto(store.db, id, photo, now)
      it.photoId = photo.id
    }
    if (Object.keys(clean).length) await updateItem(store.db, id, clean, now)
    const leaves = clean.tabId !== undefined
    Object.assign(it, clean, { updatedAt: now })
    if (it.category == null) delete it.category // mirror updateItem: absent key, never null
    if (leaves) store.selected.clear() // it is no longer in the visible tab
    settle()
    await bump(1)
    notify()
  }
}

/** Compress a picked file for editItem(..., photo). Slow, so it runs outside the queue. */
export async function prepareReplacement(file, compressFn = compress) {
  if (!file?.type?.startsWith('image/')) throw new Error('not-an-image')
  return compressFn(file)
}

/** Create a tab at the end and make it current. @param {string} name */
export function addTab(name) {
  return queue(async () => {
    if (!name.trim()) throw new Error('empty-name')
    const now = new Date().toISOString()
    const order = store.tabs.reduce((m, t) => Math.max(m, t.order), -1) + 1
    const tab = { id: crypto.randomUUID(), name: name.trim(), order, createdAt: now, updatedAt: now }
    await putTab(store.db, tab)
    store.tabs.push(tab)
    store.currentTabId = tab.id
    store.selected.clear()
    await bump(1)
    notify()
  })
}

export function renameTab(id, name) {
  return queue(async () => {
    if (!name.trim()) throw new Error('empty-name')
    const tab = store.tabs.find((t) => t.id === id)
    if (!tab) throw new Error('not-found')
    const next = { ...tab, name: name.trim(), updatedAt: new Date().toISOString() }
    await putTab(store.db, next)
    Object.assign(tab, next)
    await bump(1)
    notify()
  })
}

/** Rewrite `order` as 0..n-1 following `ids`; only tabs whose order changed get a new updatedAt. */
export function reorderTabs(ids) {
  return queue(async () => {
    const now = new Date().toISOString()
    const byId = new Map(store.tabs.map((t) => [t.id, t]))
    const changed = []
    ids.forEach((id, order) => {
      const t = byId.get(id)
      if (t && t.order !== order) changed.push({ ...t, order, updatedAt: now })
    })
    if (!changed.length) return
    await putTabs(store.db, changed)
    for (const t of changed) Object.assign(byId.get(t.id), t)
    store.tabs.sort((a, b) => a.order - b.order)
    await bump(1)
    notify()
  })
}

/** Delete a tab with its items and photos; rejects (Error 'last-tab') for the only tab. */
export function removeTab(id) {
  return queue(async () => {
    const n = store.items.filter((i) => i.tabId === id).length
    await deleteTab(store.db, id)
    const { tabs, items } = await loadAll(store.db)
    store.tabs = tabs
    store.items = items
    store.selected.clear()
    if (store.currentTabId === id || !tabs.some((t) => t.id === store.currentTabId)) store.currentTabId = tabs[0]?.id ?? null
    settle()
    await bump(Math.max(1, n))
    notify()
  })
}

/** Create a category at the end. @param {string} name */
export function addCategory(name) {
  return queue(async () => {
    if (!name.trim()) throw new Error('empty-name')
    const now = new Date().toISOString()
    const order = store.categories.reduce((m, c) => Math.max(m, c.order), -1) + 1
    const cat = { id: crypto.randomUUID(), name: name.trim(), order, createdAt: now, updatedAt: now }
    await putCategory(store.db, cat)
    store.categories.push(cat)
    await bump(1)
    notify()
  })
}

/** Renaming makes a default a custom category: nameKey is dropped so the typed name sticks in every language. */
export function renameCategory(id, name) {
  return queue(async () => {
    if (!name.trim()) throw new Error('empty-name')
    const cat = store.categories.find((c) => c.id === id)
    if (!cat) throw new Error('not-found')
    if (name.trim() === categoryName(cat)) return // same text as shown: keep a default's nameKey, count nothing
    const { nameKey: _key, ...rest } = cat
    const next = { ...rest, name: name.trim(), updatedAt: new Date().toISOString() }
    await putCategory(store.db, next)
    delete cat.nameKey
    Object.assign(cat, next)
    await bump(1)
    notify()
  })
}

/** Rewrite `order` as 0..n-1 following `ids`; only categories whose order changed get a new updatedAt. */
export function reorderCategories(ids) {
  return queue(async () => {
    const now = new Date().toISOString()
    const byId = new Map(store.categories.map((c) => [c.id, c]))
    const changed = []
    ids.forEach((id, order) => {
      const c = byId.get(id)
      if (c && c.order !== order) changed.push({ ...c, order, updatedAt: now })
    })
    if (!changed.length) return
    await putCategories(store.db, changed)
    for (const c of changed) Object.assign(byId.get(c.id), c)
    store.categories.sort((a, b) => a.order - b.order)
    await bump(1)
    notify()
  })
}

/** Delete a category; its items stay, uncategorised (db.js bumps their updatedAt). */
export function removeCategory(id) {
  return queue(async () => {
    if (!store.categories.some((c) => c.id === id)) throw new Error('not-found')
    const now = new Date().toISOString()
    await deleteCategory(store.db, id, now)
    store.categories = store.categories.filter((c) => c.id !== id)
    for (const it of store.items) {
      if (it.category === id) { delete it.category; it.updatedAt = now }
    }
    settle()
    await bump(1)
    notify()
  })
}

/** Add the defaults that are missing (never automatic), named in the current language, as ONE change. */
export function addDefaultCategories() {
  return queue(async () => {
    const missing = missingDefaults(store.categories)
    if (!missing.length) return
    const now = new Date().toISOString()
    const start = store.categories.reduce((m, c) => Math.max(m, c.order), -1) + 1
    const cats = missing.map((d, i) => ({
      id: d.id, name: t(d.nameKey), nameKey: d.nameKey, order: start + i, createdAt: now, updatedAt: now,
    }))
    await putCategories(store.db, cats)
    store.categories.push(...cats)
    await bump(1)
    notify()
  })
}
