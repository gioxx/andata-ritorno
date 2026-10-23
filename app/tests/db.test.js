import { describe, it, expect } from 'vitest'
import {
  openDb, loadAll, putTab, deleteTab, addItems, moveItems, updateItem,
  replacePhoto, deleteItems, getPhoto, getMeta, setMeta, applyPlan, setVersionChangeHandler,
} from '../src/db.js'

const T0 = '2026-01-01T00:00:00.000Z'
const T1 = '2026-02-01T00:00:00.000Z'
const fresh = () => openDb('ar-test-' + crypto.randomUUID())
const tab = (id, order = 0) => ({ id, name: id, order, createdAt: T0, updatedAt: T0 })
const item = (id, tabId, photoId = 'p-' + id) => ({
  id, tabId, location: 'school', label: id, photoId, createdAt: T0, movedAt: T0, updatedAt: T0,
})
const photo = (id, content = id) => ({ id, blob: new Blob([content], { type: 'image/jpeg' }), width: 1, height: 1 })
const count = (db, store) => db.count(store)

async function seed(db) {
  await putTab(db, tab('A', 0))
  await putTab(db, tab('B', 1))
  await addItems(db, [item('i1', 'A'), item('i2', 'A'), item('i3', 'B')], [photo('p-i1'), photo('p-i2'), photo('p-i3')])
}

describe('db', () => {
  it('loadAll returns tabs sorted by order', async () => {
    const db = await fresh()
    await putTab(db, tab('B', 1))
    await putTab(db, tab('A', 0))
    const { tabs } = await loadAll(db)
    expect(tabs.map((t) => t.id)).toEqual(['A', 'B'])
  })

  it('deleteTab removes its items and photos', async () => {
    const db = await fresh()
    await seed(db)
    await deleteTab(db, 'A')
    expect(await db.getAll('items')).toHaveLength(1)
    expect((await db.getAll('photos')).map((p) => p.id)).toEqual(['p-i3'])
    expect((await db.getAll('tabs')).map((t) => t.id)).toEqual(['B'])
  })

  it('deleteTab refuses the last tab', async () => {
    const db = await fresh()
    await putTab(db, tab('A'))
    await addItems(db, [item('i1', 'A')], [photo('p-i1')])
    await expect(deleteTab(db, 'A')).rejects.toThrow('last-tab')
    expect(await count(db, 'tabs')).toBe(1)
    expect(await count(db, 'items')).toBe(1)
    expect(await count(db, 'photos')).toBe(1)
  })

  it('moveItems changes movedAt but not updatedAt', async () => {
    const db = await fresh()
    await seed(db)
    await moveItems(db, ['i1'], 'home', T1)
    const it = await db.get('items', 'i1')
    expect(it.location).toBe('home')
    expect(it.movedAt).toBe(T1)
    expect(it.updatedAt).toBe(T0)
  })

  it('updateItem changes updatedAt but not movedAt', async () => {
    const db = await fresh()
    await seed(db)
    await updateItem(db, 'i1', { label: 'new', category: 'shirt' }, T1)
    const it = await db.get('items', 'i1')
    expect(it.label).toBe('new')
    expect(it.category).toBe('shirt')
    expect(it.updatedAt).toBe(T1)
    expect(it.movedAt).toBe(T0)
  })

  it('replacePhoto deletes the old blob', async () => {
    const db = await fresh()
    await seed(db)
    await replacePhoto(db, 'i1', photo('p-new'), T1)
    expect(await db.get('photos', 'p-i1')).toBeUndefined()
    expect(await db.get('photos', 'p-new')).toBeDefined()
    const it = await db.get('items', 'i1')
    expect(it.photoId).toBe('p-new')
    expect(it.updatedAt).toBe(T1)
  })

  it('deleteItems removes items and photos', async () => {
    const db = await fresh()
    await seed(db)
    await deleteItems(db, ['i1', 'i3'])
    expect((await db.getAllKeys('items'))).toEqual(['i2'])
    expect((await db.getAllKeys('photos'))).toEqual(['p-i2'])
  })

  it('getPhoto returns the stored blob', async () => {
    const db = await fresh()
    await seed(db)
    const b = await getPhoto(db, 'p-i1')
    // jsdom Blob may not round-trip through fake-indexeddb as a Blob; check shape only
    expect(b).toBeDefined()
    expect(await getPhoto(db, 'nope')).toBeUndefined()
  })

  it('meta round-trips', async () => {
    const db = await fresh()
    expect(await getMeta(db, 'k')).toBeUndefined()
    await setMeta(db, 'k', { a: 1 })
    expect(await getMeta(db, 'k')).toEqual({ a: 1 })
  })

  it('applyPlan writes everything in one go', async () => {
    const db = await fresh()
    await seed(db)
    await applyPlan(db, {
      tabsPut: [tab('C', 2)],
      itemsPut: [item('i9', 'C')],
      photosPut: new Map([['p-i9', new Blob(['x'])]]),
      photosDelete: ['p-i1'],
      added: 1, updated: 0,
    })
    expect(await count(db, 'tabs')).toBe(3)
    expect(await count(db, 'items')).toBe(4)
    expect(await db.get('photos', 'p-i1')).toBeUndefined()
    expect(await db.get('photos', 'p-i9')).toBeDefined()
  })

  it('applyPlan is atomic', async () => {
    const db = await fresh()
    await seed(db)
    const before = [await count(db, 'tabs'), await count(db, 'items'), await count(db, 'photos')]
    await expect(applyPlan(db, {
      tabsPut: [tab('C', 2)],
      itemsPut: [item('ok', 'C'), { label: 'no id' }],
      photosPut: new Map([['p-new', new Blob(['x'])]]),
      photosDelete: ['p-i1'],
      added: 2, updated: 0,
    })).rejects.toThrow()
    const after = [await count(db, 'tabs'), await count(db, 'items'), await count(db, 'photos')]
    expect(after).toEqual(before)
    expect(await db.get('photos', 'p-i1')).toBeDefined()
  })

  it('versionchange closes the connection and calls the handler', async () => {
    const name = 'ar-test-' + crypto.randomUUID()
    let calls = 0
    setVersionChangeHandler(() => { calls++ })
    await openDb(name)
    const db2 = await new Promise((resolve, reject) => {
      const req = indexedDB.open(name, 2)
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
      req.onblocked = () => reject(new Error('blocked'))
    })
    expect(calls).toBe(1)
    db2.close()
    setVersionChangeHandler(null)
  })
})
