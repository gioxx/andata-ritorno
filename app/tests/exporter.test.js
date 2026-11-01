import { describe, it, expect, vi } from 'vitest'
import { unzipSync, strFromU8 } from 'fflate'
import { openDb, getMeta, setMeta, putTab, addItems } from '../src/db.js'
import { exportBackup, markBackupDone } from '../src/backup/exporter.js'
import { prepareImport, commitImport } from '../src/backup/importer.js'
import { setFamily, kitOf } from '../src/sync/family.js'

const T = '2026-02-01T00:00:00.000Z'
async function seeded() {
  const db = await openDb('ar-exp-' + crypto.randomUUID())
  await putTab(db, { id: 't', name: 'Nido', order: 0, createdAt: T, updatedAt: T })
  await addItems(db,
    [{ id: 'i', tabId: 't', location: 'school', label: 'x', photoId: 'p', createdAt: T, movedAt: T, updatedAt: T }],
    [{ id: 'p', blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/webp' }), width: 1, height: 1 }])
  await setMeta(db, 'unsavedCount', 5)
  return db
}
const now = new Date('2026-10-23T10:00:00.000Z')

describe('exportBackup', () => {
  it('a download is not counted as a backup yet: the page cannot see whether the file was saved', async () => {
    const db = await seeded()
    const download = vi.fn()
    const r = await exportBackup(db, { share: async () => false, download, now })
    expect(r).toBe('downloaded')
    const file = download.mock.calls[0][0]
    expect(file.name).toBe('andata-ritorno-2026-10-23.zip')
    expect(file.type).toBe('application/zip')
    expect(await getMeta(db, 'lastBackupAt')).toBeUndefined()
    expect(await getMeta(db, 'unsavedCount')).toBe(5)
  })

  it('markBackupDone records the backup and keeps changes made after it', async () => {
    const db = await seeded()
    await setMeta(db, 'unsavedCount', 7) // 5 in the backup, 2 made while the user looked for the file
    await markBackupDone(db, now, 5)
    expect(await getMeta(db, 'lastBackupAt')).toBe(now.toISOString())
    expect(await getMeta(db, 'unsavedCount')).toBe(2)
    await markBackupDone(db, now, 9)
    expect(await getMeta(db, 'unsavedCount')).toBe(0)
  })

  it('shared', async () => {
    const db = await seeded()
    const download = vi.fn()
    expect(await exportBackup(db, { share: async () => true, download, now })).toBe('shared')
    expect(download).not.toHaveBeenCalled()
    expect(await getMeta(db, 'unsavedCount')).toBe(0)
  })

  it('AbortError → cancelled, meta untouched', async () => {
    const db = await seeded()
    const download = vi.fn()
    const share = async () => { throw Object.assign(new Error('x'), { name: 'AbortError' }) }
    expect(await exportBackup(db, { share, download, now })).toBe('cancelled')
    expect(download).not.toHaveBeenCalled()
    expect(await getMeta(db, 'lastBackupAt')).toBeUndefined()
    expect(await getMeta(db, 'unsavedCount')).toBe(5)
  })

  it('share refused (NotAllowedError) → falls back to download', async () => {
    const db = await seeded()
    const download = vi.fn()
    const share = async () => { throw Object.assign(new Error('x'), { name: 'NotAllowedError' }) }
    expect(await exportBackup(db, { share, download, now })).toBe('downloaded')
    expect(download).toHaveBeenCalledOnce()
    expect(await getMeta(db, 'unsavedCount')).toBe(5)
  })

  it('missing photo → throws with item id, meta untouched', async () => {
    const db = await seeded()
    await db.delete('photos', 'p')
    const download = vi.fn()
    await expect(exportBackup(db, { share: async () => false, download, now })).rejects.toThrow('missing-photo:i')
    expect(download).not.toHaveBeenCalled()
    expect(await getMeta(db, 'lastBackupAt')).toBeUndefined()
    expect(await getMeta(db, 'unsavedCount')).toBe(5)
  })

  it('exportedAt uses the injected now', async () => {
    const db = await seeded()
    const download = vi.fn()
    await exportBackup(db, { share: async () => false, download, now })
    const entries = unzipSync(new Uint8Array(await download.mock.calls[0][0].arrayBuffer()))
    expect(JSON.parse(new TextDecoder().decode(entries['backup.json'])).exportedAt).toBe(now.toISOString())
  })
})

describe('family kit in backups', () => {
  const kitMeta = { familyId: 'family-1234', deviceId: 'device-01', token: 't', keyRaw: 'A'.repeat(43), recoverySecret: 'secret_1234', cursor: 0, lastSyncAt: null, licenceKind: 'family' }

  async function exported(db) {
    let file = null
    await exportBackup(db, { share: async () => false, download: (f) => { file = f } })
    return file
  }

  it('a backup made in a family carries the kit, round-trips, and the importer exposes it', async () => {
    const p = { db: await seeded() }
    await setFamily(p.db, kitMeta)
    const file = await exported(p.db)
    const json = JSON.parse(strFromU8(unzipSync(new Uint8Array(await file.arrayBuffer()))['backup.json']))
    expect(json.familyKit).toBe(kitOf(kitMeta))
    const dst = { db: await openDb('ar-exp-' + crypto.randomUUID()) }
    const prepared = await prepareImport(dst.db, file)
    expect(prepared.incoming.familyKit).toBe(kitOf(kitMeta))
    const summary = await commitImport(dst.db, prepared, { partial: false })
    expect(summary.familyKit).toBe(kitOf(kitMeta))
  })

  it('outside a family there is no kit', async () => {
    const p = { db: await seeded() }
    const file = await exported(p.db)
    const json = JSON.parse(strFromU8(unzipSync(new Uint8Array(await file.arrayBuffer()))['backup.json']))
    expect('familyKit' in json).toBe(false)
    const dst = { db: await openDb('ar-exp-' + crypto.randomUUID()) }
    const summary = await commitImport(dst.db, await prepareImport(dst.db, file), { partial: false })
    expect(summary.familyKit).toBeNull()
  })
})
