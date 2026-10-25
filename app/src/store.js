// In-memory state mirrored from IndexedDB. Every action writes via db.js first,
// then updates memory and notifies, so the UI never shows something that isn't saved.
import { loadAll, moveItems, deleteItems, addItems, getMeta, setMeta, putTab, putTabs, deleteTab, updateItem, replacePhoto } from './db.js'
import { compress } from './photos.js'

/** @typedef {import('./types.js').Tab} Tab */
/** @typedef {import('./types.js').Item} Item */

export const store = {
  db: /** @type {any} */ (null),
  /** @type {Tab[]} */ tabs: [],
  /** @type {Item[]} */ items: [],
  /** @type {string|null} */ currentTabId: null,
  /** @type {Set<string>} */ selected: new Set(),
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
  const { tabs, items } = await loadAll(db)
  store.db = db
  store.tabs = tabs
  store.items = items
  store.unsaved = (await getMeta(db, 'unsavedCount')) ?? 0
  store.selected = new Set()
  if (!tabs.some((t) => t.id === store.currentTabId)) store.currentTabId = tabs[0]?.id ?? null
  notify()
}

export function setCurrentTab(id) {
  if (id === store.currentTabId) return
  store.currentTabId = id
  store.selected.clear()
  notify()
}

export function selectToggle(id) {
  if (!store.selected.delete(id)) store.selected.add(id)
  notify()
}

/** Select every item of the current tab in `location`; if all are already selected, deselect them. */
export function selectSection(location) {
  const ids = store.items
    .filter((i) => i.tabId === store.currentTabId && i.location === location)
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
function queue(fn) {
  const run = chain.then(fn)
  chain = run.catch(() => {}) // a failed action must not block the next one
  return run
}

async function bump(n) {
  const next = store.unsaved + n
  await setMeta(store.db, 'unsavedCount', next)
  store.unsaved = next
}

/** @param {number} n changes since the last export */
export function markChanged(n) {
  return queue(async () => {
    await bump(n)
    notify()
  })
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

export function deleteSelected() {
  const ids = takeSelection()
  if (!ids.length) return Promise.resolve()
  return queue(async () => {
    try {
      await deleteItems(store.db, ids)
      const set = new Set(ids)
      store.items = store.items.filter((i) => !set.has(i.id))
      await bump(ids.length)
      notify()
    } catch (e) { restoreSelection(ids); throw e }
  })
}

/**
 * Add one item per photo to the current tab. Rejects (e.g. QuotaExceededError) with
 * nothing added: addItems writes photos and items in one transaction.
 * @param {import('./types.js').Photo[]} photos
 * @param {{location: 'school'|'home', label: string}} opts
 */
export function addPhotos(photos, { location, label }) {
  const tabId = store.currentTabId
  return queue(async () => {
    const now = new Date().toISOString()
    const items = photos.map((photo) => ({
      id: crypto.randomUUID(), tabId, location, label, photoId: photo.id,
      createdAt: now, movedAt: now, updatedAt: now,
    }))
    await addItems(store.db, items, photos)
    store.items.push(...items)
    await bump(items.length)
    notify()
  })
}

const EDITABLE = ['label', 'tabId', 'category']

/**
 * Edit label / tab / category (anything else is ignored) and optionally replace the photo,
 * as ONE change. Changes updatedAt, never movedAt. Nothing changed = nothing written.
 * The replaced blob is deleted in replacePhoto's transaction; the old object URL is dropped
 * by the next render (it revokes URLs of photos no longer in use).
 * @param {string} id
 * @param {{label?:string, tabId?:string, category?:string}} patch
 * @param {import('./types.js').Photo|null} [photo] already compressed, see prepareReplacement
 */
export function editItem(id, patch, photo = null) {
  return queue(async () => {
    const it = store.items.find((i) => i.id === id)
    if (!it) throw new Error('not-found')
    const clean = {}
    for (const k of EDITABLE) if (patch[k] !== undefined) clean[k] = patch[k]
    if (clean.label !== undefined) clean.label = String(clean.label).trim()
    if (clean.tabId !== undefined && !store.tabs.some((t) => t.id === clean.tabId)) throw new Error('not-found')
    for (const k of Object.keys(clean)) if (clean[k] === (it[k] ?? (k === 'label' ? '' : undefined))) delete clean[k]
    if (!Object.keys(clean).length && !photo) return
    const now = new Date().toISOString()
    if (photo) {
      await replacePhoto(store.db, id, photo, now)
      it.photoId = photo.id
    }
    if (Object.keys(clean).length) await updateItem(store.db, id, clean, now)
    const leaves = clean.tabId !== undefined
    Object.assign(it, clean, { updatedAt: now })
    if (leaves) store.selected.clear() // it is no longer in the visible tab
    await bump(1)
    notify()
  })
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
    await bump(Math.max(1, n))
    notify()
  })
}
