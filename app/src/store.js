// In-memory state mirrored from IndexedDB. Every action writes via db.js first,
// then updates memory and notifies, so the UI never shows something that isn't saved.
import { loadAll, moveItems, deleteItems, getMeta, setMeta } from './db.js'

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

async function bump(n) {
  const next = store.unsaved + n
  await setMeta(store.db, 'unsavedCount', next)
  store.unsaved = next
}

/** @param {number} n changes since the last export */
export async function markChanged(n) {
  await bump(n)
  notify()
}

export async function move(location) {
  const ids = [...store.selected]
  if (!ids.length) return
  const now = new Date().toISOString()
  await moveItems(store.db, ids, location, now)
  for (const it of store.items) if (store.selected.has(it.id)) { it.location = location; it.movedAt = now }
  await bump(ids.length)
  store.selected.clear()
  notify()
}

export async function deleteSelected() {
  const ids = [...store.selected]
  if (!ids.length) return
  await deleteItems(store.db, ids)
  store.items = store.items.filter((i) => !store.selected.has(i.id))
  await bump(ids.length)
  store.selected.clear()
  notify()
}
