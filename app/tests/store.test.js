import { describe, it, expect, beforeEach } from 'vitest'
import { openDb, putTab, addItems, getMeta, loadAll } from '../src/db.js'
import { store, load, selectToggle, selectSection, clearSelection, move, deleteSelected, markChanged, subscribe } from '../src/store.js'

const T0 = '2026-01-01T00:00:00.000Z'
const tab = (id, order) => ({ id, name: id, order, createdAt: T0, updatedAt: T0 })
const item = (id, tabId, location) => ({
  id, tabId, location, label: id, photoId: 'p-' + id, createdAt: T0, movedAt: T0, updatedAt: T0,
})
const photo = (id) => ({ id, blob: new Blob([id], { type: 'image/jpeg' }), width: 1, height: 1 })

let db
beforeEach(async () => {
  db = await openDb('ar-test-' + crypto.randomUUID())
  await putTab(db, tab('A', 0))
  await putTab(db, tab('B', 1))
  const items = [item('a1', 'A', 'school'), item('a2', 'A', 'school'), item('a3', 'A', 'home'), item('b1', 'B', 'school')]
  await addItems(db, items, items.map((i) => photo(i.photoId)))
  await load(db)
})

describe('store', () => {
  it('load picks the first tab and an empty selection', () => {
    expect(store.currentTabId).toBe('A')
    expect(store.selected.size).toBe(0)
    expect(store.unsaved).toBe(0)
  })

  it('selectSection selects exactly the current-tab items of that location; second call clears', () => {
    selectSection('school')
    expect([...store.selected].sort()).toEqual(['a1', 'a2'])
    selectSection('school')
    expect(store.selected.size).toBe(0)
  })

  it('selectSection keeps the other section selection when clearing', () => {
    selectToggle('a3')
    selectSection('school')
    selectSection('school')
    expect([...store.selected]).toEqual(['a3'])
  })

  it('move updates location, movedAt and unsaved by selection size, persisted', async () => {
    selectSection('school')
    await move('home')
    expect(store.items.filter((i) => i.tabId === 'A' && i.location === 'home').length).toBe(3)
    expect(store.items.find((i) => i.id === 'a1').movedAt).not.toBe(T0)
    expect(store.selected.size).toBe(0)
    expect(store.unsaved).toBe(2)
    expect(await getMeta(db, 'unsavedCount')).toBe(2)
    expect((await loadAll(db)).items.find((i) => i.id === 'a2').location).toBe('home')
  })

  it('deleteSelected removes from db and memory and counts changes', async () => {
    selectToggle('a1')
    selectToggle('b1')
    await deleteSelected()
    expect(store.items.map((i) => i.id).sort()).toEqual(['a2', 'a3'])
    expect((await loadAll(db)).items.length).toBe(2)
    expect(store.unsaved).toBe(2)
  })

  it('markChanged increments the persisted counter and notifies', async () => {
    let calls = 0
    const off = subscribe(() => calls++)
    await markChanged(1)
    await markChanged(2)
    off()
    expect(store.unsaved).toBe(3)
    expect(await getMeta(db, 'unsavedCount')).toBe(3)
    expect(calls).toBe(2)
  })

  it('clearSelection empties the selection', () => {
    selectToggle('a1')
    clearSelection()
    expect(store.selected.size).toBe(0)
  })
})
