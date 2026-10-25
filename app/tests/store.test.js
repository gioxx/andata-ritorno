import { describe, it, expect, beforeEach, vi } from 'vitest'
import { openDb, putTab, addItems, getMeta, loadAll, getPhoto } from '../src/db.js'
import { store, load, selectToggle, selectSection, clearSelection, move, deleteSelected, markChanged, addPhotos, subscribe, addTab, renameTab, reorderTabs, removeTab, editItem, rotateAndEdit, prepareReplacement, addCategory, removeCategory, renameCategory, addDefaultCategories, toggleFilter, clearFilter, setCurrentTab } from '../src/store.js'

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

describe('edit item', () => {
  it('editItem changes updatedAt not movedAt, trims, persists, counts one change', async () => {
    await editItem('a1', { label: '  felpa blu ' })
    const it = store.items.find((i) => i.id === 'a1')
    expect(it.label).toBe('felpa blu')
    expect(it.updatedAt).not.toBe(T0)
    expect(it.movedAt).toBe(T0)
    expect(store.unsaved).toBe(1)
    const saved = (await loadAll(db)).items.find((i) => i.id === 'a1')
    expect(saved.label).toBe('felpa blu')
    expect(saved.movedAt).toBe(T0)
  })

  it('editItem ignores fields outside the whitelist', async () => {
    await editItem('a1', { label: 'x', location: 'home', photoId: 'zzz', id: 'evil' })
    const it = store.items.find((i) => i.id === 'a1')
    expect(it.location).toBe('school')
    expect(it.photoId).toBe('p-a1')
    expect((await loadAll(db)).items.find((i) => i.id === 'a1').location).toBe('school')
  })

  it('moving to another tab removes it from the view and clears the selection', async () => {
    selectToggle('a1')
    await editItem('a1', { tabId: 'B' })
    expect(store.items.find((i) => i.id === 'a1').tabId).toBe('B')
    expect(store.selected.size).toBe(0)
    await expect(editItem('a1', { tabId: 'nope' })).rejects.toThrow('not-found')
  })

  it('saving with a new photo replaces the blob exactly once and counts ONE change with the fields', async () => {
    const fake = async () => photo('new')
    const p = await prepareReplacement(new File(['x'], 'x.jpg', { type: 'image/jpeg' }), fake)
    await editItem('a1', { label: 'nuova' }, p)
    const it = store.items.find((i) => i.id === 'a1')
    expect(it.photoId).toBe('new')
    expect(it.label).toBe('nuova')
    expect(await getPhoto(db, 'p-a1')).toBeUndefined()
    expect(await getPhoto(db, 'new')).toBeDefined()
    expect(it.movedAt).toBe(T0)
    expect(store.unsaved).toBe(1)
    expect((await loadAll(db)).items.find((i) => i.id === 'a1').photoId).toBe('new')
  })

  it('preparing a replacement and cancelling (never calling editItem) leaves the original blob intact', async () => {
    const before = await (await getPhoto(db, 'p-a1')).text()
    await prepareReplacement(new File(['x'], 'x.jpg', { type: 'image/jpeg' }), async () => photo('new'))
    expect(await (await getPhoto(db, 'p-a1')).text()).toBe(before)
    expect(await getPhoto(db, 'new')).toBeUndefined()
    expect(store.items.find((i) => i.id === 'a1').photoId).toBe('p-a1')
    expect(store.unsaved).toBe(0)
  })

  it('saving with nothing changed writes and counts nothing', async () => {
    await editItem('a1', { label: ' a1 ', tabId: 'A' })
    expect(store.items.find((i) => i.id === 'a1').updatedAt).toBe(T0)
    expect(store.unsaved).toBe(0)
  })

  it('a net-zero rotation (no photo, no field change) writes nothing', async () => {
    await editItem('a1', {}, null)
    expect(store.items.find((i) => i.id === 'a1').photoId).toBe('p-a1')
    expect(store.unsaved).toBe(0)
  })

  it('two back-to-back 1-turn saves rotate 180 degrees and leave one photo record', async () => {
    vi.stubGlobal('createImageBitmap', async (b) => ({ width: b.size !== 2 ? 600 : 400, height: b.size !== 2 ? 400 : 600, close() {} }))
    const canvas = { width: 0, height: 0, getContext: () => ({ translate() {}, rotate() {}, drawImage() {} }) }
    vi.stubGlobal('document', { createElement: () => canvas })
    // blob size encodes orientation: 2 bytes = portrait, anything else = landscape
    const encode = async (c) => new Blob([c.width > c.height ? 'a' : 'bb'], { type: 'image/webp' })
    await Promise.all([rotateAndEdit('a1', {}, 1, null, encode), rotateAndEdit('a1', {}, 1, null, encode)])
    const id = store.items.find((i) => i.id === 'a1').photoId
    const blob = await getPhoto(db, id)
    expect(blob.size).toBe(1) // landscape again: 90 + 90 = 180
    expect(await getPhoto(db, 'p-a1')).toBeUndefined()
    vi.unstubAllGlobals()
  })

  it('a failed rotation still saves the field edits and returns the error', async () => {
    vi.stubGlobal('createImageBitmap', async () => ({ width: 2, height: 1, close() {} }))
    vi.stubGlobal('document', { createElement: () => ({ getContext: () => ({ translate() {}, rotate() {}, drawImage() {} }) }) })
    const err = await rotateAndEdit('a1', { label: 'nuova' }, 1, null, async () => { throw new Error('boom') })
    vi.unstubAllGlobals()
    expect(err.message).toBe('boom')
    const it = store.items.find((i) => i.id === 'a1')
    expect(it.label).toBe('nuova')
    expect(it.photoId).toBe('p-a1')
  })

  it('prepareReplacement rejects a non-image', async () => {
    await expect(prepareReplacement(new File(['x'], 'x.txt', { type: 'text/plain' }))).rejects.toThrow('not-an-image')
  })

  it('removeCategory keeps items, uncategorised, and bumps their updatedAt', async () => {
    await addCategory('Costumi')
    const cid = store.categories[0].id
    await editItem('a1', { category: cid })
    expect(store.items.find((i) => i.id === 'a1').category).toBe(cid)
    await removeCategory(cid)
    const mem = store.items.find((i) => i.id === 'a1')
    expect(mem).toBeDefined()
    expect('category' in mem).toBe(false)
    expect(mem.updatedAt > T0).toBe(true)
    await load(db)
    const stored = store.items.find((i) => i.id === 'a1')
    expect('category' in stored).toBe(false)
    expect(store.items).toHaveLength(4)
  })

  it('editItem({ category: null }) clears the category without storing undefined', async () => {
    await addCategory('Costumi')
    const cid = store.categories[0].id
    await editItem('a1', { category: cid })
    await editItem('a1', { category: null })
    expect('category' in store.items.find((i) => i.id === 'a1')).toBe(false)
    const { items } = await loadAll(db)
    expect('category' in items.find((i) => i.id === 'a1')).toBe(false)
  })

  it('editItem rejects an unknown category id and writes nothing', async () => {
    await expect(editItem('a1', { category: 'ghost' })).rejects.toThrow('not-found')
    expect('category' in store.items.find((i) => i.id === 'a1')).toBe(false)
    expect(store.unsaved).toBe(0)
  })

  it('addPhotos stores a valid category and rejects an unknown one', async () => {
    await addCategory('Costumi')
    const cid = store.categories[0].id
    await addPhotos([photo('n1')], { location: 'home', label: 'x', category: cid })
    expect(store.items.find((i) => i.photoId === 'n1').category).toBe(cid)
    await expect(addPhotos([photo('n2')], { location: 'home', label: 'x', category: 'ghost' })).rejects.toThrow('not-found')
    expect(store.items.some((i) => i.photoId === 'n2')).toBe(false)
    await addPhotos([photo('n3')], { location: 'home', label: 'x' })
    expect('category' in store.items.find((i) => i.photoId === 'n3')).toBe(false)
  })

  it('renameCategory to the text already shown is a no-op and keeps the nameKey', async () => {
    await addDefaultCategories()
    const c = store.categories[0]
    const before = { unsaved: store.unsaved, updatedAt: c.updatedAt }
    await renameCategory(c.id, `  ${c.name}  `)
    expect(c.nameKey).toBe('category.default.body')
    expect(store.unsaved).toBe(before.unsaved)
    expect(c.updatedAt).toBe(before.updatedAt)
    await renameCategory(c.id, 'Tutine')
    expect('nameKey' in c).toBe(false)
    expect(store.unsaved).toBe(before.unsaved + 1)
  })

  it('removeCategory on an unknown id throws not-found and counts nothing', async () => {
    await expect(removeCategory('ghost')).rejects.toThrow('not-found')
    expect(store.unsaved).toBe(0)
  })

  describe('tag filter', () => {
    let c1, c2
    beforeEach(async () => {
      await addCategory('Uno'); await addCategory('Due')
      ;[c1, c2] = store.categories.map((c) => c.id)
      await editItem('a1', { category: c1 })
      await editItem('a2', { category: c2 })
      await editItem('b1', { category: c1 })
    })

    it('selectSection respects the filter', () => {
      toggleFilter(c1)
      selectSection('school')
      expect([...store.selected]).toEqual(['a1'])
    })

    it('removing a filtered category empties the filter and shows every item', async () => {
      toggleFilter(c1)
      await removeCategory(c1)
      expect(store.filter.size).toBe(0)
      const { visibleItems } = await import('../src/ui/filter.js')
      expect(visibleItems(store.items, store.filter)).toBe(store.items)
    })

    it('switching tab clears the filter', () => {
      toggleFilter(c1)
      setCurrentTab('B')
      expect(store.filter.size).toBe(0)
    })

    it('changing the filter drops selected items that became hidden; clearFilter keeps the rest', () => {
      selectToggle('a1'); selectToggle('a2')
      toggleFilter(c1)
      expect([...store.selected]).toEqual(['a1'])
      clearFilter()
      expect(store.filter.size).toBe(0)
      expect([...store.selected]).toEqual(['a1'])
    })

    it('a filter category that no item of the tab uses any more is dropped', async () => {
      toggleFilter(c2)
      await editItem('a2', { category: null })
      expect(store.filter.size).toBe(0)
    })
  })
})
