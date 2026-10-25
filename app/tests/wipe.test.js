import { describe, it, expect } from 'vitest'
import { openDb, addItems, putTab, loadAll } from '../src/db.js'
import { wipeAll } from '../src/wipe.js'

const fakeStorage = (init) => {
  const m = new Map(Object.entries(init))
  return { get length() { return m.size }, key: (i) => [...m.keys()][i] ?? null, getItem: (k) => m.get(k) ?? null, removeItem: (k) => { m.delete(k) }, setItem: (k, v) => { m.set(k, v) }, keys: () => [...m.keys()] }
}

describe('wipeAll', () => {
  it('empties the DB and removes only ar-* keys', async () => {
    const db = await openDb()
    await putTab(db, { id: 't', name: 'Casa', order: 0 })
    await addItems(db, [{ id: 'i', tabId: 't', location: 'home', label: '', photoId: 'p' }], [{ id: 'p', blob: new Blob(['x']), width: 1, height: 1 }])
    const local = fakeStorage({ 'ar-theme': 'dark', 'ar-lang': 'it', 'ar-install-strip': '1', other: 'keep' })
    const session = fakeStorage({ 'ar-ios-banner': '1', other: 'keep' })

    await wipeAll({ db, storages: [local, session] })

    expect(local.keys()).toEqual(['other'])
    expect(session.keys()).toEqual(['other'])
    const fresh = await openDb()
    expect(await loadAll(fresh)).toEqual({ tabs: [], items: [], categories: [] })
    expect(await fresh.count('photos')).toBe(0)
    fresh.close()
  })

  it('keeps storage keys when the DB cannot be deleted', async () => {
    const db = await openDb()
    const local = fakeStorage({ 'ar-theme': 'dark' })
    const failing = () => { const req = {}; setTimeout(() => { req.error = new Error('nope'); req.onerror() }, 0); return req }
    await expect(wipeAll({ db, deleteDatabase: failing, storages: [local] })).rejects.toThrow('nope')
    expect(local.keys()).toEqual(['ar-theme'])
  })

  it('waits for a blocked delete to finish', async () => {
    const db = await openDb()
    let done = false
    const slow = () => { const req = {}; setTimeout(() => req.onblocked(), 0); setTimeout(() => { done = true; req.onsuccess() }, 20); return req }
    await wipeAll({ db, deleteDatabase: slow, storages: [] })
    expect(done).toBe(true)
  })
})
