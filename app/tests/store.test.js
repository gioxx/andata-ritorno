import { describe, it, expect, beforeEach } from 'vitest'
import { openDb, putTab, addItems, getMeta, loadAll } from '../src/db.js'
import { store, load, selectToggle, selectSection, clearSelection, move, deleteSelected, markChanged, addPhotos, subscribe, addTab, renameTab, reorderTabs, removeTab } from '../src/store.js'

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

  it('two concurrent move() calls count the selection once', async () => {
    selectSection('school')
    await Promise.all([move('home'), move('home')])
    expect(store.unsaved).toBe(2)
    expect(await getMeta(db, 'unsavedCount')).toBe(2)
  })

  it('concurrent markChanged calls do not lose increments', async () => {
    await Promise.all([markChanged(1), markChanged(1), markChanged(1)])
    expect(store.unsaved).toBe(3)
    expect(await getMeta(db, 'unsavedCount')).toBe(3)
  })

  it('addPhotos adds items to the current tab, persists them and counts changes', async () => {
    const photos = [photo('n1'), photo('n2')]
    await addPhotos(photos, { location: 'school', label: 'felpa' })
    const added = store.items.filter((i) => i.photoId === 'n1' || i.photoId === 'n2')
    expect(added.length).toBe(2)
    expect(added.every((i) => i.tabId === 'A' && i.location === 'school' && i.label === 'felpa' && i.createdAt === i.movedAt)).toBe(true)
    expect(store.unsaved).toBe(2)
    expect((await loadAll(db)).items.length).toBe(6)
  })

  it('addPhotos adds nothing when the write fails', async () => {
    const bad = { id: 'bad', blob: new Blob(['x']), width: 1, height: 1 }
    const real = db.transaction.bind(db)
    db.transaction = () => { throw new DOMException('full', 'QuotaExceededError') }
    await expect(addPhotos([bad], { location: 'home', label: '' })).rejects.toMatchObject({ name: 'QuotaExceededError' })
    db.transaction = real
    expect(store.items.length).toBe(4)
    expect(store.unsaved).toBe(0)
  })
})

describe('tab management', () => {
  it('addTab appends, becomes current and counts as a change', async () => {
    await addTab('  Nido  ')
    const t = store.tabs.at(-1)
    expect(t.name).toBe('Nido')
    expect(t.order).toBe(2)
    expect(store.currentTabId).toBe(t.id)
    expect(store.unsaved).toBe(1)
    expect((await loadAll(db)).tabs).toHaveLength(3)
  })

  it('addTab and renameTab reject empty names', async () => {
    await expect(addTab('   ')).rejects.toThrow('empty-name')
    await expect(renameTab('A', ' ')).rejects.toThrow('empty-name')
    expect(store.tabs).toHaveLength(2)
    expect(store.tabs[0].name).toBe('A')
  })

  it('renameTab keeps items tabId and bumps updatedAt', async () => {
    await renameTab('A', 'Nuovo')
    expect(store.tabs.find((t) => t.id === 'A').name).toBe('Nuovo')
    expect(store.tabs.find((t) => t.id === 'A').updatedAt).not.toBe(T0)
    expect(store.items.filter((i) => i.tabId === 'A')).toHaveLength(3)
    const { tabs, items } = await loadAll(db)
    expect(tabs.find((t) => t.id === 'A').name).toBe('Nuovo')
    expect(items.filter((i) => i.tabId === 'A')).toHaveLength(3)
  })

  it('reorderTabs rewrites order and touches only changed tabs', async () => {
    await addTab('C')
    const c = store.tabs.at(-1).id
    await reorderTabs(['A', c, 'B'])
    expect(store.tabs.map((t) => t.id)).toEqual(['A', c, 'B'])
    expect(store.tabs.map((t) => t.order)).toEqual([0, 1, 2])
    expect(store.tabs.find((t) => t.id === 'A').updatedAt).toBe(T0)
    expect(store.tabs.find((t) => t.id === 'B').updatedAt).not.toBe(T0)
    expect((await loadAll(db)).tabs.map((t) => t.id)).toEqual(['A', c, 'B'])
  })

  it('removeTab deletes its items, switches current tab and counts them', async () => {
    await removeTab('A')
    expect(store.tabs.map((t) => t.id)).toEqual(['B'])
    expect(store.currentTabId).toBe('B')
    expect(store.items.map((i) => i.id)).toEqual(['b1'])
    expect(store.unsaved).toBe(3)
  })

  it('removeTab on the last tab rejects and changes nothing', async () => {
    await removeTab('B')
    await expect(removeTab('A')).rejects.toThrow('last-tab')
    expect(store.tabs).toHaveLength(1)
    expect(store.items).toHaveLength(3)
  })
})
