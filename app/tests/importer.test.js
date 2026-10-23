import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { openDb, loadAll, putTab, getPhoto, getMeta } from '../src/db.js'
import { prepareImport, commitImport, formatSummary, ImportBlocked } from '../src/backup/importer.js'
import sample from './fixtures/v1-sample.json'

const T0 = '2026-01-01T00:00:00.000Z'
const fresh = () => openDb('ar-imp-' + crypto.randomUUID())
const fileOf = (data) => new File([JSON.stringify(data)], 'andata-ritorno.json', { type: 'application/json' })
const withPhoto = (i, photo) => {
  const data = structuredClone(sample)
  data.items[i].photo = photo
  return data
}
const counts = async (db) => ({
  tabs: await db.count('tabs'), items: await db.count('items'),
  photos: await db.count('photos'), meta: await db.count('meta'),
})
const bytesOf = async (b) => new Uint8Array(await b.arrayBuffer())
const run = async (db, data, opts = {}) => commitImport(db, await prepareImport(db, fileOf(data)), opts)

// The global stub accepts any non-empty image blob; a real browser would reject
// 'AAAA' (3 bytes). Here only blobs with a RIFF....WEBP header decode, like a browser.
const looseDecoder = globalThis.createImageBitmap
beforeAll(() => {
  globalThis.createImageBitmap = async (blob) => {
    const h = new Uint8Array(await blob.slice(0, 12).arrayBuffer())
    const tag = (from) => String.fromCharCode(...h.slice(from, from + 4))
    if (tag(0) === 'RIFF' && tag(8) === 'WEBP') return { width: 1, height: 1, close() {} }
    throw new Error('decode failed')
  }
})
afterAll(() => { globalThis.createImageBitmap = looseDecoder })
afterEach(() => vi.restoreAllMocks())

describe('importer', () => {
  it('v1 import on empty db creates Nido and Materna and all 3 items with photos', async () => {
    const db = await fresh()
    const prepared = await prepareImport(db, fileOf(sample))
    expect(prepared.needsMapping).toEqual([])
    const summary = await commitImport(db, prepared, { partial: false })
    expect(summary.added).toBe(3)
    expect(formatSummary(summary)).toBe(
      'Importati 3 capi · Nido 2 (1 a scuola, 1 a casa) · Materna 1 (1 a scuola, 0 a casa)',
    )
    const { tabs, items } = await loadAll(db)
    expect(tabs.map((t) => t.name)).toEqual(['Nido', 'Materna'])
    expect(items).toHaveLength(3)
    expect(await getMeta(db, 'childMap')).toEqual({ nido: tabs[0].id, materna: tabs[1].id })
  })

  it('migrated photo bytes are identical', async () => {
    const db = await fresh()
    await run(db, sample)
    const { items } = await loadAll(db)
    for (const src of sample.items) {
      const it = items.find((i) => i.id === src.id)
      const stored = await getPhoto(db, it.photoId)
      // Decoded independently of dataUrlToBlob so a bug there cannot cancel out.
      const expected = new Uint8Array(Buffer.from(src.photo.split(',')[1], 'base64'))
      expect(stored.type).toBe('image/webp')
      expect(await bytesOf(stored)).toEqual(expected)
    }
  })

  it('one bad photo blocks import and writes nothing', async () => {
    const db = await fresh()
    const prepared = await prepareImport(db, fileOf(withPhoto(2, 'data:image/webp;base64,AAAA')))
    const err = await commitImport(db, prepared, { partial: false }).catch((e) => e)
    expect(err).toBeInstanceOf(ImportBlocked)
    expect(err.failures).toEqual([{
      itemId: sample.items[2].id, label: 'Felpa blu', tabName: 'Materna', location: 'school', reason: 'Foto non leggibile',
    }])
    expect(await counts(db)).toEqual({ tabs: 0, items: 0, photos: 0, meta: 0 })
  })

  it('partial import writes the others and stores the todo', async () => {
    const db = await fresh()
    const summary = await run(db, withPhoto(2, 'data:image/webp;base64,AAAA'), { partial: true })
    expect(summary).toMatchObject({ added: 2, updated: 0, failed: 1 })
    expect(formatSummary(summary)).toBe('Importati 2 capi · Nido 2 (1 a scuola, 1 a casa) · 1 da rifare')
    const { tabs, items } = await loadAll(db)
    expect(items).toHaveLength(2)
    expect(tabs.map((t) => t.name)).toEqual(['Nido'])
    const todo = await getMeta(db, 'todo')
    expect(todo).toHaveLength(1)
    expect(todo[0]).toMatchObject({ label: 'Felpa blu', tabName: 'Materna', reason: 'Foto non leggibile' })
    // Same file again: the todo entry is not duplicated.
    await run(db, withPhoto(2, 'data:image/webp;base64,AAAA'), { partial: true })
    expect(await getMeta(db, 'todo')).toHaveLength(1)
  })

  it('re-import reuses tabs via childMap', async () => {
    const db = await fresh()
    await run(db, sample)
    const again = await prepareImport(db, fileOf(sample))
    expect(again.needsMapping).toEqual([])
    const summary = await commitImport(db, again, { partial: false })
    expect(summary).toMatchObject({ added: 0, updated: 0 })
    expect(await db.count('tabs')).toBe(2)
    expect(await db.count('items')).toBe(3)
    expect(await db.count('photos')).toBe(3) // no orphan photos from the second parse
  })

  it('existing tabs → needsMapping lists children', async () => {
    const db = await fresh()
    await putTab(db, { id: 'sofia', name: 'Nido di Sofia', order: 0, createdAt: T0, updatedAt: T0 })
    expect((await prepareImport(db, fileOf(sample))).needsMapping).toEqual(['nido', 'materna'])
    const prepared = await prepareImport(db, fileOf(sample), { childMap: { nido: 'sofia', materna: 'new' } })
    expect(prepared.needsMapping).toEqual([])
    const summary = await commitImport(db, prepared, { partial: false })
    const { tabs, items } = await loadAll(db)
    expect(tabs.map((t) => t.name)).toEqual(['Nido di Sofia', 'Materna'])
    const byId = Object.fromEntries(items.map((i) => [i.id, i.tabId]))
    expect(byId[sample.items[0].id]).toBe('sofia')
    expect(byId[sample.items[1].id]).toBe('sofia')
    expect(byId[sample.items[2].id]).toBe(tabs[1].id)
    expect(formatSummary(summary)).toBe(
      'Importati 3 capi · Nido di Sofia 2 (1 a scuola, 1 a casa) · Materna 1 (1 a scuola, 0 a casa)',
    )
    // The mapping is remembered: next time nothing is asked.
    expect((await prepareImport(db, fileOf(sample))).needsMapping).toEqual([])
  })

  it('a stored mapping to a deleted tab is asked again', async () => {
    const db = await fresh()
    await run(db, sample)
    const { tabs } = await loadAll(db)
    await db.delete('tabs', tabs[1].id) // simulate "Materna" gone
    expect((await prepareImport(db, fileOf(sample))).needsMapping).toEqual(['materna'])
  })

  it('quota error leaves db unchanged', async () => {
    const db = await fresh()
    await putTab(db, { id: 'sofia', name: 'Nido di Sofia', order: 0, createdAt: T0, updatedAt: T0 })
    const prepared = await prepareImport(db, fileOf(sample), { childMap: { nido: 'sofia', materna: 'new' } })
    const before = await counts(db)
    // Fail inside the real applyPlan tx, after tab/item puts were already queued.
    const put = IDBObjectStore.prototype.put
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (...args) {
      if (this.name === 'photos') throw new DOMException('full', 'QuotaExceededError')
      return put.apply(this, args)
    })
    await expect(commitImport(db, prepared, { partial: false })).rejects.toThrow('quota')
    vi.restoreAllMocks()
    expect(await counts(db)).toEqual(before)
    expect(await getMeta(db, 'childMap')).toBeUndefined()
  })

  it('same id twice in the v1 file', async () => {
    const db = await fresh()
    const data = structuredClone(sample)
    data.items.push({ ...data.items[0], location: 'home', movedAt: '2025-09-20T07:00:00.000Z' })
    const summary = await run(db, data)
    const { items } = await loadAll(db)
    expect(items).toHaveLength(3)
    expect(items.find((i) => i.id === sample.items[0].id).location).toBe('home') // later move wins
    expect(summary.added).toBe(3)
    expect(formatSummary(summary)).toBe(
      'Importati 3 capi · Nido 2 (0 a scuola, 2 a casa) · Materna 1 (1 a scuola, 0 a casa)',
    )
    expect(await db.count('photos')).toBe(3)
  })

  it('a later mockup move updates an item but never its v2 edits', async () => {
    const db = await fresh()
    await run(db, sample)
    const id = sample.items[0].id
    const cur = (await loadAll(db)).items.find((i) => i.id === id)
    await db.put('items', { ...cur, label: 'Rinominato in v2', updatedAt: T0 })
    const data = structuredClone(sample)
    data.items[0].movedAt = '2026-03-01T00:00:00.000Z'
    data.items[0].location = 'home'
    const summary = await run(db, data)
    expect(summary).toMatchObject({ added: 0, updated: 1 })
    expect(formatSummary(summary)).toBe('Importati 0 capi · Nido 2 (0 a scuola, 2 a casa) · Materna 1 (1 a scuola, 0 a casa) · 1 aggiornato')
    const it = (await loadAll(db)).items.find((i) => i.id === id)
    expect(it).toMatchObject({ label: 'Rinominato in v2', location: 'home', photoId: cur.photoId })
  })

  it('verify fails when a planned photo is missing after commit', async () => {
    const db = await fresh()
    const prepared = await prepareImport(db, fileOf(sample))
    prepared.plan.photosPut.set(prepared.plan.itemsPut[0].photoId, new Blob([], { type: 'image/webp' }))
    await expect(commitImport(db, prepared, { partial: false })).rejects.toThrow('verify-failed')
  })

  it('corrupt ZIPs and unknown files are rejected', async () => {
    const db = await fresh()
    const zip = new File([new Uint8Array([0x50, 0x4b, 3, 4])], 'b.zip')
    await expect(prepareImport(db, zip)).rejects.toThrow('bad-file')
    await expect(prepareImport(db, new File(['{}'], 'x.json'))).rejects.toThrow('bad-file')
  })

  it('formatSummary uses the singular for one item', () => {
    expect(formatSummary({ added: 1, updated: 2, failed: 0, perTab: [{ tabName: 'Nido', school: 1, home: 0 }] }))
      .toBe('Importato 1 capo · Nido 1 (1 a scuola, 0 a casa) · 2 aggiornati')
  })

  it('verify fails when an unchanged local item of the file has lost its photo', async () => {
    const db = await fresh()
    await run(db, sample)
    const cur = (await loadAll(db)).items.find((i) => i.id === sample.items[0].id)
    await db.delete('photos', cur.photoId)
    const prepared = await prepareImport(db, fileOf(sample))
    expect(prepared.plan.itemsPut).toHaveLength(0) // skipped by buildPlan as unchanged
    await expect(commitImport(db, prepared, { partial: false })).rejects.toThrow('verify-failed')
  })
})
