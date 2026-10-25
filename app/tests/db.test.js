import { describe, it, expect } from 'vitest'
import { openDB } from 'idb'
import {
  openDb, loadAll, putTab, deleteTab, addItems, moveItems, updateItem,
  replacePhoto, deleteItems, getPhoto, getMeta, setMeta, applyPlan, setVersionChangeHandler,
  putCategory, deleteCategory, putCategories, putTabs, setItemsCategory,
  setSyncTracking, readOutbox, clearOutbox, getTombstones, putTombstones, clearSyncStores, clearWardrobe, applySyncPlan,
} from '../src/db.js'

const T0 = '2026-01-01T00:00:00.000Z'
const T1 = '2026-02-01T00:00:00.000Z'
const fresh = () => openDb('ar-test-' + crypto.randomUUID())
const tab = (id, order = 0) => ({ id, name: id, order, createdAt: T0, updatedAt: T0 })
const item = (id, tabId, photoId = 'p-' + id) => ({
  id, tabId, location: 'school', label: id, photoId, createdAt: T0, movedAt: T0, updatedAt: T0,
})
const photo = (id, content = id) => ({ id, blob: new Blob([content], { type: 'image/jpeg' }), width: 1, height: 1 })
async function expectBlob(b, text, type = 'image/jpeg') {
  expect(b).toBeInstanceOf(Blob)
  expect(b.type).toBe(type)
  expect(b.size).toBe(text.length)
  expect(await b.text()).toBe(text)
}
const count = (db, store) => db.count(store)
const cat = (id, order = 0) => ({ id, name: id, order, createdAt: T0, updatedAt: T0 })

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
    await deleteTab(db, 'A', T1)
    expect(await db.getAll('items')).toHaveLength(1)
    expect((await db.getAll('photos')).map((p) => p.id)).toEqual(['p-i3'])
    expect((await db.getAll('tabs')).map((t) => t.id)).toEqual(['B'])
  })

  it('deleteTab refuses the last tab', async () => {
    const db = await fresh()
    await putTab(db, tab('A'))
    await addItems(db, [item('i1', 'A')], [photo('p-i1')])
    await expect(deleteTab(db, 'A', T1)).rejects.toThrow('last-tab')
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
    await expectBlob(await getPhoto(db, 'p-new'), 'p-new')
    const it = await db.get('items', 'i1')
    expect(it.photoId).toBe('p-new')
    expect(it.updatedAt).toBe(T1)
  })

  it('replacePhoto sets photoAt = now', async () => {
    const db = await fresh()
    await seed(db)
    await replacePhoto(db, 'i1', photo('p-new'), T1)
    expect((await db.get('items', 'i1')).photoAt).toBe(T1)
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
    await expectBlob(b, 'p-i1')
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
      photosPut: new Map([['p-i9', new Blob(['xyz'], { type: 'image/png' })]]),
      metaPut: [['todo', [1]]],
      photosDelete: ['p-i1'],
      added: 1, updated: 0,
    })
    expect(await count(db, 'tabs')).toBe(3)
    expect(await count(db, 'items')).toBe(4)
    expect(await db.get('photos', 'p-i1')).toBeUndefined()
    await expectBlob(await getPhoto(db, 'p-i9'), 'xyz', 'image/png')
    expect(await getMeta(db, 'todo')).toEqual([1])
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
      metaPut: [['todo', ['valid']]],
      added: 2, updated: 0,
    })).rejects.toThrow()
    const after = [await count(db, 'tabs'), await count(db, 'items'), await count(db, 'photos')]
    expect(after).toEqual(before)
    expect(await db.get('photos', 'p-i1')).toBeDefined()
    expect(await getMeta(db, 'todo')).toBeUndefined()
  })

  it('async request failure rejects once with the original error and aborts', async () => {
    const real = await fresh()
    await seed(real)
    // Make the items put an `add`, so an existing id fails asynchronously (ConstraintError).
    const db = {
      transaction: (...a) => {
        const tx = real.transaction(...a)
        return {
          done: tx.done,
          abort: () => tx.abort(),
          objectStore: (n) => {
            const s = tx.objectStore(n)
            return n === 'items' ? { put: (v) => s.add(v) } : s
          },
        }
      },
    }
    const before = await count(real, 'tabs')
    await expect(applyPlan(db, {
      tabsPut: [tab('C', 2)],
      itemsPut: [item('i1', 'A')],
      photosPut: new Map(), photosDelete: [], added: 0, updated: 0,
    })).rejects.toMatchObject({ name: 'ConstraintError' })
    expect(await count(real, 'tabs')).toBe(before)
  })

  it('versionchange closes the connection and calls the handler', async () => {
    const name = 'ar-test-' + crypto.randomUUID()
    let calls = 0
    setVersionChangeHandler(() => { calls++ })
    await openDb(name)
    const db2 = await new Promise((resolve, reject) => {
      const req = indexedDB.open(name, 4)
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
      req.onblocked = () => reject(new Error('blocked'))
    })
    expect(calls).toBe(1)
    db2.close()
    setVersionChangeHandler(null)
  })
  it('an older connection that does not close calls onBlocked, then the open completes once it does', async () => {
    const name = 'ar-test-' + crypto.randomUUID()
    // An old tab still holding a v1 connection and ignoring versionchange.
    const old = await openDB(name, 1, {
      upgrade(db) {
        db.createObjectStore('tabs', { keyPath: 'id' })
        db.createObjectStore('items', { keyPath: 'id' }).createIndex('tabId', 'tabId')
        db.createObjectStore('photos', { keyPath: 'id' })
        db.createObjectStore('meta')
      },
    })
    let blocked = 0
    const opening = openDb(name, { onBlocked: () => { blocked++; old.close() } })
    const db = await opening
    expect(blocked).toBe(1)
    expect(db.objectStoreNames.contains('categories')).toBe(true)
    db.close()
  })
  it('upgrade from v1 keeps everything', async () => {
    const name = 'ar-test-' + crypto.randomUUID()
    // Exact v1 schema, as shipped.
    const v1 = await openDB(name, 1, {
      upgrade(db) {
        db.createObjectStore('tabs', { keyPath: 'id' })
        db.createObjectStore('items', { keyPath: 'id' }).createIndex('tabId', 'tabId')
        db.createObjectStore('photos', { keyPath: 'id' })
        db.createObjectStore('meta')
      },
    })
    const tabs = [tab('A', 0), tab('B', 1)]
    const items = [item('i1', 'A'), { ...item('i2', 'A'), category: 'shirt' }, item('i3', 'B')]
    const photos = [photo('p-i1', 'one'), photo('p-i2', 'two!'), photo('p-i3', 'three')]
    for (const t of tabs) await v1.put('tabs', t)
    for (const i of items) await v1.put('items', i)
    for (const p of photos) await v1.put('photos', p)
    await v1.put('meta', { a: 1 }, 'k1')
    await v1.put('meta', ['x'], 'k2')
    v1.close()

    const db = await openDb(name)
    expect(db.version).toBe(3)
    expect(await db.getAll('tabs')).toEqual(tabs)
    expect(await db.getAll('items')).toEqual(items)
    for (const p of photos) {
      const got = await db.get('photos', p.id)
      expect({ ...got, blob: null }).toEqual({ ...p, blob: null })
      await expectBlob(got.blob, await p.blob.text())
    }
    expect(await getMeta(db, 'k1')).toEqual({ a: 1 })
    expect(await getMeta(db, 'k2')).toEqual(['x'])
    expect(db.objectStoreNames.contains('categories')).toBe(true)
    expect(await count(db, 'categories')).toBe(0)
    expect(await db.getAllFromIndex('items', 'category', 'shirt')).toEqual([items[1]])
    expect(await db.getAllFromIndex('items', 'tabId', 'A')).toHaveLength(2)
    db.close()
  })

  it('loadAll returns categories sorted by order', async () => {
    const db = await fresh()
    await putCategory(db, cat('c2', 1))
    await putCategory(db, cat('c1', 0))
    const { categories } = await loadAll(db)
    expect(categories.map((c) => c.id)).toEqual(['c1', 'c2'])
  })

  it('putCategories and putTabs write all records', async () => {
    const db = await fresh()
    await putCategories(db, [cat('c1', 1), cat('c2', 0)])
    await putTabs(db, [tab('A', 1), tab('B', 0)])
    const { tabs, categories } = await loadAll(db)
    expect(categories.map((c) => c.id)).toEqual(['c2', 'c1'])
    expect(tabs.map((t) => t.id)).toEqual(['B', 'A'])
  })

  it('deleteCategory leaves items uncategorised', async () => {
    const db = await fresh()
    await putTab(db, tab('A'))
    await putCategories(db, [cat('c1', 0), cat('c2', 1)])
    await addItems(db, [
      { ...item('i1', 'A'), category: 'c1' },
      { ...item('i2', 'A'), category: 'c1' },
      { ...item('i3', 'A'), category: 'c2' },
      item('i4', 'A'),
    ], [photo('p-i1'), photo('p-i2'), photo('p-i3'), photo('p-i4')])
    await deleteCategory(db, 'c1', T1)
    expect(await db.getAllKeys('categories')).toEqual(['c2'])
    for (const id of ['i1', 'i2']) {
      const it = await db.get('items', id)
      expect(it).toBeDefined()
      expect('category' in it).toBe(false)
      expect(it.updatedAt).toBe(T1)
      expect(it.movedAt).toBe(T0)
    }
    expect(await db.get('items', 'i3')).toEqual({ ...item('i3', 'A'), category: 'c2' })
    expect(await db.get('items', 'i4')).toEqual(item('i4', 'A'))
    expect(await count(db, 'photos')).toBe(4)
  })

  it('updateItem ignores unknown fields', async () => {
    const db = await fresh()
    await seed(db)
    await updateItem(db, 'i1', { label: 'x', id: 'evil', movedAt: 'y' }, T1)
    expect(await db.get('items', 'evil')).toBeUndefined()
    expect(await db.get('items', 'i1')).toEqual({ ...item('i1', 'A'), label: 'x', updatedAt: T1 })
  })

  it('applyPlan writes categoriesPut atomically', async () => {
    const db = await fresh()
    await seed(db)
    await expect(applyPlan(db, {
      tabsPut: [],
      categoriesPut: [cat('c1', 0)],
      itemsPut: [{ label: 'no id' }],
      photosPut: new Map(), photosDelete: [], metaPut: [],
      added: 1, updated: 0,
    })).rejects.toThrow()
    expect(await count(db, 'categories')).toBe(0)
    await applyPlan(db, {
      tabsPut: [], categoriesPut: [cat('c1', 0)], itemsPut: [],
      photosPut: new Map(), photosDelete: [], metaPut: [], added: 0, updated: 0,
    })
    expect(await db.getAllKeys('categories')).toEqual(['c1'])
  })

  describe('v3 sync outbox and tombstones', () => {
    const keys = async (db) => (await readOutbox(db)).map((e) => `${e.kind}:${e.id}`).sort()
    const track = (on) => setSyncTracking(on)
    const finish = () => setSyncTracking(false)

    it('upgrade v2 -> v3 keeps every record byte-identical', async () => {
      const name = 'ar-test-' + crypto.randomUUID()
      const v2 = await openDB(name, 2, {
        upgrade(db) {
          db.createObjectStore('tabs', { keyPath: 'id' })
          db.createObjectStore('items', { keyPath: 'id' }).createIndex('tabId', 'tabId')
          db.createObjectStore('photos', { keyPath: 'id' })
          db.createObjectStore('meta')
          db.createObjectStore('categories', { keyPath: 'id' })
        },
      })
      const tabs = [tab('A', 0), tab('B', 1)]
      const cats = [cat('c1', 0), cat('c2', 1)]
      const items = [item('i1', 'A'), { ...item('i2', 'A'), category: 'c1', photoAt: T1 }, item('i3', 'B')]
      const photos = [photo('p-i1', 'one'), photo('p-i2', 'two!'), photo('p-i3', 'three')]
      for (const t of tabs) await v2.put('tabs', t)
      for (const c of cats) await v2.put('categories', c)
      for (const i of items) await v2.put('items', i)
      for (const p of photos) await v2.put('photos', p)
      await v2.put('meta', { a: 1 }, 'k1')
      await v2.put('meta', 5, 'unsavedCount')
      v2.close()

      const db = await openDb(name)
      expect(db.version).toBe(3)
      expect(await db.getAll('tabs')).toEqual(tabs)
      expect(await db.getAll('categories')).toEqual(cats)
      expect(await db.getAll('items')).toEqual(items)
      for (const p of photos) {
        const got = await db.get('photos', p.id)
        expect({ ...got, blob: null }).toEqual({ ...p, blob: null })
        await expectBlob(got.blob, await p.blob.text())
      }
      expect(await getMeta(db, 'k1')).toEqual({ a: 1 })
      expect(await getMeta(db, 'unsavedCount')).toBe(5)
      expect(await readOutbox(db)).toEqual([])
      expect((await getTombstones(db)).size).toBe(0)
      db.close()
    })

    it('with tracking off, writes add no outbox entries', async () => {
      const db = await fresh()
      await seed(db)
      await moveItems(db, ['i1'], 'home', T1)
      await deleteItems(db, ['i2'], T1)
      await deleteCategory(db, 'none', T1)
      expect(await readOutbox(db)).toEqual([])
      expect((await getTombstones(db)).size).toBe(0)
    })

    it('tracking on: edits record outbox entries', async () => {
      const db = await fresh()
      await seed(db)
      track(true)
      try {
        await moveItems(db, ['i1'], 'home', T1)
        await updateItem(db, 'i2', { label: 'x' }, T1)
        await putTab(db, tab('C', 2))
        await putCategory(db, cat('c1'))
        await putTabs(db, [tab('A', 1), tab('B', 0)])
        await putCategories(db, [cat('c1', 3)])
        await setItemsCategory(db, ['i3'], 'c1', T1)
        await replacePhoto(db, 'i3', photo('p-new'), T1)
        await addItems(db, [item('i4', 'A')], [photo('p-i4')])
      } finally { finish() }
      expect(await keys(db)).toEqual(
        ['category:c1', 'item:i1', 'item:i2', 'item:i3', 'item:i4', 'tab:A', 'tab:B', 'tab:C'])
    })

    it('tracking on: deleteItems writes tombstones + outbox in one tx', async () => {
      const db = await fresh()
      await seed(db)
      track(true)
      try {
        await deleteItems(db, ['i1', 'i3'], T1)
      } finally { finish() }
      const ts = await getTombstones(db)
      expect([...ts.values()].sort((a, b) => a.id.localeCompare(b.id))).toEqual([
        { kind: 'item', id: 'i1', deletedAt: T1 }, { kind: 'item', id: 'i3', deletedAt: T1 },
      ])
      expect(await keys(db)).toEqual(['item:i1', 'item:i3'])
    })

    it('tracking on: a failing write leaves neither tombstone nor outbox entry', async () => {
      const db = await fresh()
      await seed(db)
      track(true)
      try {
        // A non-cloneable `now` makes the tombstone put throw after the item delete is queued.
        await expect(deleteItems(db, ['i1'], () => {})).rejects.toBeTruthy()
      } finally { finish() }
      expect(await db.count('items')).toBe(3)
      expect((await getTombstones(db)).size).toBe(0)
      expect(await readOutbox(db)).toEqual([])
    })

    it('tracking on: deleteTab tombstones the tab and each of its items', async () => {
      const db = await fresh()
      await seed(db)
      track(true)
      try { await deleteTab(db, 'A', T1) } finally { finish() }
      const ts = await getTombstones(db)
      expect([...ts.keys()].sort()).toEqual(['A', 'i1', 'i2'])
      expect(ts.get('A')).toEqual({ kind: 'tab', id: 'A', deletedAt: T1 })
      expect(ts.get('i1')).toEqual({ kind: 'item', id: 'i1', deletedAt: T1 })
      expect(await keys(db)).toEqual(['item:i1', 'item:i2', 'tab:A'])
    })

    it('tracking on: deleteCategory tombstones the category and does not rewrite items', async () => {
      const db = await fresh()
      await putTab(db, tab('A'))
      await putCategory(db, cat('c1'))
      const it = { ...item('i1', 'A'), category: 'c1' }
      await addItems(db, [it], [photo('p-i1')])
      track(true)
      try { await deleteCategory(db, 'c1', T1) } finally { finish() }
      expect(await db.get('items', 'i1')).toEqual(it)
      expect(await db.count('categories')).toBe(0)
      expect((await getTombstones(db)).get('c1')).toEqual({ kind: 'category', id: 'c1', deletedAt: T1 })
      expect(await keys(db)).toEqual(['category:c1'])
    })

    it('tombstone and outbox helpers round-trip', async () => {
      const db = await fresh()
      await putTombstones(db, [{ kind: 'tab', id: 't', deletedAt: T0 }])
      expect((await getTombstones(db)).get('t')).toEqual({ kind: 'tab', id: 't', deletedAt: T0 })
      track(true)
      try { await putTab(db, tab('A')); await putTab(db, tab('B')) } finally { finish() }
      await clearOutbox(db, ['tab:A'])
      expect(await keys(db)).toEqual(['tab:B'])
      await clearSyncStores(db)
      expect(await readOutbox(db)).toEqual([])
      expect((await getTombstones(db)).size).toBe(0)
    })

    it('clearWardrobe empties data stores, keeps meta', async () => {
      const db = await fresh()
      await seed(db)
      await putCategory(db, cat('c1'))
      await setMeta(db, 'k', 'v')
      await setMeta(db, 'unsavedCount', 4)
      track(true)
      try { await moveItems(db, ['i1'], 'home', T1); await deleteItems(db, ['i2'], T1) } finally { finish() }
      await clearWardrobe(db)
      for (const s of ['tabs', 'categories', 'items', 'photos', 'outbox', 'tombstones']) expect(await db.count(s)).toBe(0)
      expect(await getMeta(db, 'k')).toBe('v')
      expect(await getMeta(db, 'unsavedCount')).toBe(0)
    })

    const plan = (over) => ({
      tabsPut: [], categoriesPut: [], itemsPut: [], photosPut: new Map(), photosDelete: [], added: 0, updated: 0, ...over,
    })

    it('applyPlan with tracking on records every put and revives tombstoned ids', async () => {
      const db = await fresh()
      await putTombstones(db, [
        { kind: 'tab', id: 'T', deletedAt: T1 }, { kind: 'item', id: 'i9', deletedAt: T1 },
      ])
      track(true)
      try {
        await applyPlan(db, plan({
          tabsPut: [tab('T'), tab('U')],
          categoriesPut: [cat('c1')],
          itemsPut: [item('i9', 'T'), item('i8', 'U')],
          photosPut: new Map([['p-i9', new Blob(['x'])], ['p-i8', new Blob(['y'])]]),
        }), '2026-03-01T00:00:00.000Z')
      } finally { finish() }
      expect(await keys(db)).toEqual(['category:c1', 'item:i8', 'item:i9', 'tab:T', 'tab:U'])
      expect((await getTombstones(db)).size).toBe(0)
      const now = '2026-03-01T00:00:00.000Z'
      expect((await db.get('tabs', 'T')).updatedAt).toBe(now)
      expect((await db.get('items', 'i9')).updatedAt).toBe(now)
      expect((await db.get('tabs', 'U')).updatedAt).toBe(T0)
      expect((await db.get('items', 'i8')).updatedAt).toBe(T0)
    })

    it('applyPlan with tracking off leaves tombstones and outbox alone', async () => {
      const db = await fresh()
      await putTombstones(db, [{ kind: 'tab', id: 'T', deletedAt: T1 }])
      await applyPlan(db, plan({ tabsPut: [tab('T')] }))
      expect((await getTombstones(db)).size).toBe(1)
      expect(await readOutbox(db)).toEqual([])
      expect((await db.get('tabs', 'T')).updatedAt).toBe(T0)
    })
  })
})

describe('applySyncPlan', () => {
  const syncPlan = (p) => ({
    tabsPut: [], tabsDelete: [], categoriesPut: [], categoriesDelete: [], itemsPut: [], itemsDelete: [],
    photosDelete: [], tombstonesPut: [], tombstonesDelete: [], pushBack: [], photosNeeded: [], movedOrphans: 0,
    changesBy: new Map(), ...p,
  })
  const outboxKeys = async (db) => (await readOutbox(db)).map((e) => `${e.kind}:${e.id}`).sort()

  async function seeded() {
    const db = await fresh()
    await seed(db)
    await putCategory(db, cat('c1'))
    await putTombstones(db, [{ kind: 'item', id: 'i9', deletedAt: T0 }])
    return db
  }
  const full = () => syncPlan({
    tabsPut: [tab('C', 2)], tabsDelete: ['B'],
    categoriesPut: [cat('c2', 1)], categoriesDelete: ['c1'],
    itemsPut: [{ ...item('i1', 'A'), label: 'nuovo', updatedAt: T1 }, item('i9', 'C')], itemsDelete: ['i3'],
    photosDelete: ['p-i3'],
    tombstonesPut: [{ kind: 'tab', id: 'B', deletedAt: T1 }, { kind: 'item', id: 'i3', deletedAt: T1 }],
    tombstonesDelete: ['i9'],
    pushBack: [{ kind: 'item', id: 'i1' }],
  })

  it('writes every put, delete and tombstone; only pushBack reaches the outbox, even while tracking', async () => {
    const db = await seeded()
    setSyncTracking(true)
    try {
      await applySyncPlan(db, full())
    } finally { setSyncTracking(false) }
    const { tabs, categories, items } = await loadAll(db)
    expect(tabs.map((t) => t.id)).toEqual(['A', 'C'])
    expect(categories.map((c) => c.id)).toEqual(['c2'])
    expect(items.map((i) => i.id).sort()).toEqual(['i1', 'i2', 'i9'])
    expect(items.find((i) => i.id === 'i1').label).toBe('nuovo')
    expect(await getPhoto(db, 'p-i3')).toBeUndefined()
    await expectBlob(await getPhoto(db, 'p-i1'), 'p-i1')
    expect([...(await getTombstones(db)).keys()].sort()).toEqual(['B', 'i3'])
    expect(await outboxKeys(db)).toEqual(['item:i1'])
  })

  it('keeps outbox entries already waiting', async () => {
    const db = await seeded()
    setSyncTracking(true)
    try { await moveItems(db, ['i2'], 'home', T1) } finally { setSyncTracking(false) }
    await applySyncPlan(db, syncPlan({ pushBack: [{ kind: 'tab', id: 'A' }] }))
    expect(await outboxKeys(db)).toEqual(['item:i2', 'tab:A'])
  })

  it('is atomic: one failing write leaves everything unchanged', async () => {
    const db = await seeded()
    const before = { ...(await loadAll(db)), tombs: await db.getAll('tombstones'), photos: await db.getAllKeys('photos') }
    const plan = full()
    plan.itemsPut.push({ ...item('bad', 'A'), oops: () => {} }) // not cloneable: the put throws
    await expect(applySyncPlan(db, plan)).rejects.toBeTruthy()
    expect(await loadAll(db)).toEqual({ tabs: before.tabs, categories: before.categories, items: before.items })
    expect(await db.getAll('tombstones')).toEqual(before.tombs)
    expect(await db.getAllKeys('photos')).toEqual(before.photos)
    expect(await readOutbox(db)).toEqual([])
  })
})
