import { describe, it, expect } from 'vitest'
import { zipSync, unzipSync } from 'fflate'
import { openDb, loadAll, putTab, addItems, getPhoto } from '../src/db.js'
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
  const { tabs, items } = await loadAll(db)
  return buildZip({ tabs, items, getPhoto: (id) => getPhoto(db, id) })
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

  it('photo missing in zip → failure, not orphan', async () => {
    const entries = unzipSync(await bytesOf(await zipOf(await seeded())))
    delete entries['photos/p2.jpg']
    const dst = await fresh()
    const prepared = await prepareImport(dst, asFile(new Blob([zipSync(entries)])))
    await expect(commitImport(dst, prepared, { partial: false })).rejects.toBeInstanceOf(ImportBlocked)
    expect(prepared.incoming.failures).toEqual([
      { itemId: 'i2', label: 'capo 2', tabName: 'Nido', location: 'home', reason: 'Foto mancante nel backup' },
    ])
    expect(await dst.count('items')).toBe(0)
    expect(await dst.count('photos')).toBe(0)
  })

  it("unknown tabId → failure 'Scheda mancante'", async () => {
    const entries = unzipSync(await bytesOf(await zipOf(await seeded())))
    const json = JSON.parse(new TextDecoder().decode(entries['backup.json']))
    json.items[0].tabId = 'ghost'
    entries['backup.json'] = new TextEncoder().encode(JSON.stringify(json))
    const dst = await fresh()
    const prepared = await prepareImport(dst, asFile(new Blob([zipSync(entries)])))
    expect(prepared.incoming.failures.map((f) => f.reason)).toEqual(['Scheda mancante'])
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
})
