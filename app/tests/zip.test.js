import { describe, it, expect } from 'vitest'
import { zipSync, unzipSync, Zip, ZipPassThrough, strToU8 } from 'fflate'
import { openDb, loadAll, putTab, putCategory, updateItem, addItems, getPhoto } from '../src/db.js'
import { buildZip } from '../src/backup/zip.js'
import { prepareImport, commitImport, ImportBlocked } from '../src/backup/importer.js'

const fresh = () => openDb('ar-zip-' + crypto.randomUUID())
const bytesOf = async (b) => new Uint8Array(await b.arrayBuffer())
const T = '2026-02-01T00:00:00.000Z'

async function seeded() {
  const db = await fresh()
  const tabs = [
    { id: 'tab-a', name: 'Nido', order: 0, createdAt: T, updatedAt: T },
    { id: 'tab-b', name: 'Materna', order: 1, createdAt: T, updatedAt: T },
  ]
  for (const t of tabs) await putTab(db, t)
  const mk = (n, tabId, type, location) => ({
    item: { id: 'i' + n, tabId, location, label: 'capo ' + n, photoId: 'p' + n,
      createdAt: '2026-02-0' + n + 'T00:00:00.000Z', movedAt: '2026-03-0' + n + 'T00:00:00.000Z',
      updatedAt: '2026-04-0' + n + 'T00:00:00.000Z' },
    photo: { id: 'p' + n, blob: new Blob([new Uint8Array([n, 1, 2, 3, n * 7])], { type }), width: 1, height: 1 },
  })
  const rows = [mk(1, 'tab-a', 'image/webp', 'school'), mk(2, 'tab-a', 'image/jpeg', 'home'), mk(3, 'tab-b', 'image/webp', 'school')]
  await addItems(db, rows.map((r) => r.item), rows.map((r) => r.photo))
  return db
}
const zipOf = async (db) => {
  const { tabs, items, categories } = await loadAll(db)
  return buildZip({ tabs, items, categories, getPhoto: (id) => getPhoto(db, id) })
}
const asFile = (blob) => new File([blob], 'b.zip', { type: 'application/zip' })

describe('v2 zip', () => {
  it('zip round-trip preserves everything', async () => {
    const src = await seeded()
    const file = asFile(await zipOf(src))
    const dst = await fresh()
    const summary = await commitImport(dst, await prepareImport(dst, file), { partial: false })
    expect(summary.added).toBe(3)
    const a = await loadAll(src)
    const b = await loadAll(dst)
    expect(b.tabs).toEqual(a.tabs)
    expect(b.items.sort((x, y) => x.id.localeCompare(y.id))).toEqual(a.items.sort((x, y) => x.id.localeCompare(y.id)))
    for (const it of a.items) {
      const x = await getPhoto(src, it.photoId)
      const y = await getPhoto(dst, it.photoId)
      expect(y.type).toBe(x.type)
      expect(await bytesOf(y)).toEqual(await bytesOf(x))
    }
  })

  it('names photos by type and stores them uncompressed', async () => {
    const entries = unzipSync(await bytesOf(await zipOf(await seeded())))
    expect(Object.keys(entries).sort()).toEqual(['backup.json', 'photos/p1.webp', 'photos/p2.jpg', 'photos/p3.webp'])
  })

  it('photos are stored with CRC and sizes in their local headers (no data descriptors)', async () => {
    const bytes = await bytesOf(await zipOf(await seeded()))
    const v = new DataView(bytes.buffer)
    const json = JSON.parse(new TextDecoder().decode(unzipSync(bytes)['backup.json']))
    expect(v.getUint32(0, true)).toBe(0x04034b50)
    expect(v.getUint16(6, true) & 8).toBe(0) // no data descriptor
    expect(v.getUint16(8, true)).toBe(0) // stored
    expect(v.getUint32(14, true)).toBe(json.photos.p1.crc32)
    expect(v.getUint32(18, true)).toBe(json.photos.p1.size)
    expect(v.getUint32(22, true)).toBe(json.photos.p1.size)
  })

  it('photo missing in zip → failure, not orphan', async () => {
    const entries = unzipSync(await bytesOf(await zipOf(await seeded())))
    delete entries['photos/p2.jpg']
    const dst = await fresh()
    const prepared = await prepareImport(dst, asFile(new Blob([zipSync(entries)])))
    await expect(commitImport(dst, prepared, { partial: false })).rejects.toBeInstanceOf(ImportBlocked)
    expect(prepared.incoming.failures).toEqual([
      { itemId: 'i2', label: 'capo 2', tabName: 'Nido', location: 'home', reason: 'missing-photo' },
    ])
    expect(await dst.count('items')).toBe(0)
    expect(await dst.count('photos')).toBe(0)
  })

  it("unknown tabId → failure 'missing-tab'", async () => {
    const entries = unzipSync(await bytesOf(await zipOf(await seeded())))
    const json = JSON.parse(new TextDecoder().decode(entries['backup.json']))
    json.items[0].tabId = 'ghost'
    entries['backup.json'] = new TextEncoder().encode(JSON.stringify(json))
    const dst = await fresh()
    const prepared = await prepareImport(dst, asFile(new Blob([zipSync(entries)])))
    expect(prepared.incoming.failures.map((f) => f.reason)).toEqual(['missing-tab'])
    await expect(commitImport(dst, prepared, { partial: false })).rejects.toBeInstanceOf(ImportBlocked)
    const s = await commitImport(dst, prepared, { partial: true })
    expect(s.added).toBe(2)
  })

  it('accepts a tab that exists only locally', async () => {
    const src = await seeded()
    const entries = unzipSync(await bytesOf(await zipOf(src)))
    const json = JSON.parse(new TextDecoder().decode(entries['backup.json']))
    json.tabs = json.tabs.filter((t) => t.id !== 'tab-b')
    entries['backup.json'] = new TextEncoder().encode(JSON.stringify(json))
    const dst = await fresh()
    await putTab(dst, { id: 'tab-b', name: 'Locale', order: 0, createdAt: T, updatedAt: T })
    const prepared = await prepareImport(dst, asFile(new Blob([zipSync(entries)])))
    expect(prepared.incoming.failures).toEqual([])
  })

  const edit = async (mutate) => {
    const entries = unzipSync(await bytesOf(await zipOf(await seeded())))
    mutate(entries)
    return asFile(new Blob([zipSync(entries)]))
  }
  const editJson = (fn) => (entries) => {
    const json = JSON.parse(new TextDecoder().decode(entries['backup.json']))
    fn(json)
    entries['backup.json'] = new TextEncoder().encode(JSON.stringify(json))
  }

  it.each([
    ['wrong app', editJson((j) => { j.app = 'other' })],
    ['wrong version', editJson((j) => { j.version = 3 })],
    ['missing backup.json', (e) => { delete e['backup.json'] }],
  ])('%s → bad-file', async (_n, mutate) => {
    const dst = await fresh()
    await expect(prepareImport(dst, await edit(mutate))).rejects.toThrow('bad-file')
  })

  it('photo that fails decode → unreadable-photo', async () => {
    const orig = globalThis.createImageBitmap
    globalThis.createImageBitmap = async () => { throw new Error('nope') }
    try {
      const dst = await fresh()
      const prepared = await prepareImport(dst, asFile(await zipOf(await seeded())))
      expect(prepared.incoming.failures.map((f) => f.reason)).toEqual(Array(3).fill('unreadable-photo'))
    } finally { globalThis.createImageBitmap = orig }
  })

  it('flipped byte in a photo → unreadable-photo (integrity check)', async () => {
    const file = await edit((e) => { e['photos/p1.webp'] = e['photos/p1.webp'].map((b, i) => (i === 2 ? b ^ 1 : b)) })
    const dst = await fresh()
    const prepared = await prepareImport(dst, file)
    expect(prepared.incoming.failures.map((f) => [f.itemId, f.reason])).toEqual([['i1', 'unreadable-photo']])
  })

  it('v2 file without the photos map still imports', async () => {
    const file = await edit(editJson((j) => { delete j.photos }))
    const dst = await fresh()
    expect((await prepareImport(dst, file)).incoming.failures).toEqual([])
  })

  it('png photo round-trips with its type', async () => {
    const src = await seeded()
    await addItems(src, [{ id: 'i9', tabId: 'tab-a', location: 'home', label: 'png', photoId: 'p9', createdAt: T, movedAt: T, updatedAt: T }],
      [{ id: 'p9', blob: new Blob([new Uint8Array([9, 9, 9])], { type: 'image/png' }), width: 1, height: 1 }])
    const entries = unzipSync(await bytesOf(await zipOf(src)))
    expect(entries['photos/p9.png']).toBeDefined()
    const dst = await fresh()
    await commitImport(dst, await prepareImport(dst, asFile(await zipOf(src))), { partial: false })
    expect((await getPhoto(dst, 'p9')).type).toBe('image/png')
  })

  const EPOCH = '1970-01-01T00:00:00.000Z'
  const incomingOf = async (fn) => {
    const dst = await fresh()
    return { dst, prepared: await prepareImport(dst, await edit(editJson(fn))) }
  }

  it('numeric label imports as a string', async () => {
    const { dst, prepared } = await incomingOf((j) => { j.items[0].label = 42 })
    expect(prepared.incoming.items.find((i) => i.id === 'i1').label).toBe('42')
    await commitImport(dst, prepared, { partial: false })
    const { items } = await loadAll(dst)
    expect(items.find((i) => i.id === 'i1').label).toBe('42')
  })

  it('items keep only the Item keys; category kept only as a string', async () => {
    const { prepared } = await incomingOf((j) => {
      Object.assign(j.items[0], { evil: '<x>', category: 'body' })
      Object.assign(j.items[1], { category: 7 })
    })
    const [a, b] = ['i1', 'i2'].map((id) => prepared.incoming.items.find((i) => i.id === id))
    expect(Object.keys(a).sort()).toEqual(['category', 'createdAt', 'id', 'label', 'location', 'movedAt', 'photoId', 'tabId', 'updatedAt'])
    expect(a.category).toBe('body')
    expect('category' in b).toBe(false)
  })

  it('missing movedAt → epoch; bad createdAt → movedAt; bad updatedAt → epoch', async () => {
    const { prepared } = await incomingOf((j) => {
      delete j.items[0].movedAt
      j.items[1].createdAt = 5
      j.items[1].updatedAt = 'not a date'
    })
    const [a, b] = ['i1', 'i2'].map((id) => prepared.incoming.items.find((i) => i.id === id))
    expect(a.movedAt).toBe(EPOCH)
    expect(a.createdAt).toBe('2026-02-01T00:00:00.000Z')
    expect(b.createdAt).toBe(b.movedAt)
    expect(b.updatedAt).toBe(EPOCH)
  })

  it("non-string tabId → 'incomplete'", async () => {
    const { prepared } = await incomingOf((j) => { j.items[0].tabId = 1 })
    expect(prepared.incoming.failures.map((f) => [f.itemId, f.reason])).toEqual([['i1', 'incomplete']])
  })

  it("tab without id is dropped: its items fail 'missing-tab', no DataError", async () => {
    const { dst, prepared } = await incomingOf((j) => { delete j.tabs[0].id })
    expect(prepared.incoming.tabs.map((t) => t.id)).toEqual(['tab-b'])
    expect(prepared.incoming.failures.map((f) => [f.itemId, f.reason])).toEqual([['i1', 'missing-tab'], ['i2', 'missing-tab']])
    const s = await commitImport(dst, prepared, { partial: true })
    expect(s.added).toBe(1)
    expect((await loadAll(dst)).tabs.map((t) => t.id)).toEqual(['tab-b'])
  })

  it('tabs are normalised: name, order, dates, extra keys', async () => {
    const { prepared } = await incomingOf((j) => {
      Object.assign(j.tabs[0], { name: '   ', order: 'x', createdAt: null, evil: 1 })
      Object.assign(j.tabs[1], { name: 12, updatedAt: 'nope' })
    })
    expect(prepared.incoming.tabs).toEqual([
      { id: 'tab-a', name: 'Scheda', order: 0, createdAt: EPOCH, updatedAt: T },
      { id: 'tab-b', name: '12', order: 1, createdAt: T, updatedAt: EPOCH },
    ])
  })

  it("missing photo on export throws 'missing-photo:<itemId>'", async () => {
    const src = await seeded()
    const { tabs, items } = await loadAll(src)
    await expect(buildZip({ tabs, items, getPhoto: async (id) => (id === 'p2' ? undefined : getPhoto(src, id)) }))
      .rejects.toThrow('missing-photo:i2')
  })

  it('zip round-trip keeps categories', async () => {
    const src = await seeded()
    await putCategory(src, { id: 'default-body', name: 'Body', nameKey: 'category.default.body', order: 0, createdAt: T, updatedAt: T })
    await putCategory(src, { id: 'c-custom', name: 'Costumi', order: 1, createdAt: T, updatedAt: T })
    await updateItem(src, 'i1', { category: 'c-custom' }, T)
    const dst = await fresh()
    await commitImport(dst, await prepareImport(dst, asFile(await zipOf(src))), { partial: false })
    const a = await loadAll(src)
    const b = await loadAll(dst)
    expect(b.categories).toEqual(a.categories)
    expect(b.categories).toHaveLength(2)
    expect(b.items.find((i) => i.id === 'i1').category).toBe('c-custom')
  })

  it('item with unknown category imports uncategorised; a v2 file without categories still imports', async () => {
    const src = await seeded()
    await updateItem(src, 'i1', { category: 'ghost' }, T)
    const entries = unzipSync(await bytesOf(await zipOf(src)))
    const json = JSON.parse(new TextDecoder().decode(entries['backup.json']))
    expect(json.categories).toEqual([])
    delete json.categories
    entries['backup.json'] = new TextEncoder().encode(JSON.stringify(json))
    const dst = await fresh()
    const prepared = await prepareImport(dst, asFile(new Blob([zipSync(entries)])))
    expect(prepared.incoming.categories).toEqual([])
    await commitImport(dst, prepared, { partial: false })
    const { items } = await loadAll(dst)
    expect(items).toHaveLength(3)
    expect('category' in items.find((i) => i.id === 'i1')).toBe(false)
  })

  it('normalises untrusted categories', async () => {
    const entries = unzipSync(await bytesOf(await zipOf(await seeded())))
    const json = JSON.parse(new TextDecoder().decode(entries['backup.json']))
    json.categories = [
      { id: 'default-tops', name: 'x', nameKey: 'category.default.tops', order: 3, createdAt: 'bad', updatedAt: T, extra: 1 },
      { id: 'c2', name: 'Y', nameKey: 'evil.key', order: 'nope' },
      { id: 'c3', name: 'Z', nameKey: 'category.default.socks', order: 5 }, // a default key on another id
      { id: 'default-body', name: 'W', nameKey: 'category.default.socks', order: 6 }, // wrong default key for this id
      { name: 'no id' },
    ]
    entries['backup.json'] = new TextEncoder().encode(JSON.stringify(json))
    const dst = await fresh()
    const { incoming } = await prepareImport(dst, asFile(new Blob([zipSync(entries)])))
    expect(incoming.categories).toEqual([
      { id: 'default-tops', name: 'x', nameKey: 'category.default.tops', order: 3, createdAt: '1970-01-01T00:00:00.000Z', updatedAt: T },
      { id: 'c2', name: 'Y', order: 1, createdAt: '1970-01-01T00:00:00.000Z', updatedAt: '1970-01-01T00:00:00.000Z' },
      { id: 'c3', name: 'Z', order: 5, createdAt: '1970-01-01T00:00:00.000Z', updatedAt: '1970-01-01T00:00:00.000Z' },
      { id: 'default-body', name: 'W', order: 6, createdAt: '1970-01-01T00:00:00.000Z', updatedAt: '1970-01-01T00:00:00.000Z' },
    ])
  })

  // ZIP record signatures inside photo bytes must not confuse the reader (a signature-scanning
  // stream parser would cut the photo short there).
  const SIGS = [0x50, 0x4b, 7, 8, 0x50, 0x4b, 1, 2, 0x50, 0x4b, 3, 4, 0x50, 0x4b, 5, 6]
  it('photo bytes containing ZIP signatures round-trip intact', async () => {
    const src = await seeded()
    const bytes = new Uint8Array([1, ...SIGS, 9, ...SIGS, 2])
    await addItems(src, [{ id: 'i8', tabId: 'tab-a', location: 'home', label: 'sig', photoId: 'p8', createdAt: T, movedAt: T, updatedAt: T }],
      [{ id: 'p8', blob: new Blob([bytes], { type: 'image/webp' }), width: 1, height: 1 }])
    const dst = await fresh()
    const prepared = await prepareImport(dst, asFile(await zipOf(src)))
    expect(prepared.incoming.failures).toEqual([])
    await commitImport(dst, prepared, { partial: false })
    expect(await bytesOf(await getPhoto(dst, 'p8'))).toEqual(bytes)
  })

  it('reads archives written with data descriptors (streaming writers)', async () => {
    const entries = unzipSync(await bytesOf(await zipOf(await seeded())))
    entries['photos/p1.webp'] = new Uint8Array([...entries['photos/p1.webp'], ...SIGS])
    const json = JSON.parse(new TextDecoder().decode(entries['backup.json']))
    delete json.photos // the integrity map no longer matches p1: drop it, as an older file would
    entries['backup.json'] = strToU8(JSON.stringify(json))
    const chunks = []
    const z = new Zip((err, chunk) => { if (err) throw err; chunks.push(chunk) })
    for (const [name, data] of Object.entries(entries)) {
      const f = new ZipPassThrough(name)
      z.add(f)
      f.push(data, true)
    }
    z.end()
    const dst = await fresh()
    const prepared = await prepareImport(dst, asFile(new Blob(chunks)))
    expect(prepared.incoming.failures).toEqual([])
    expect(await bytesOf(prepared.incoming.photos.get('p1'))).toEqual(entries['photos/p1.webp'])
  })

  it.each([
    ['truncated archive', (b) => b.slice(0, b.length - 30)],
    ['not a zip past the header', (b) => new Uint8Array([0x50, 0x4b, 3, 4, 0, 0, 0, 0])],
  ])('%s → bad-file', async (_n, cut) => {
    const bytes = cut(await bytesOf(await zipOf(await seeded())))
    const dst = await fresh()
    await expect(prepareImport(dst, asFile(new Blob([bytes])))).rejects.toThrow('bad-file')
  })
})
