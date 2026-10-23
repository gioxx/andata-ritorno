import { describe, it, expect, vi } from 'vitest'
import { openDb, getMeta, setMeta, putTab, addItems } from '../src/db.js'
import { exportBackup } from '../src/backup/exporter.js'

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
  it('exportBackup resets unsavedCount and sets lastBackupAt (download fallback)', async () => {
    const db = await seeded()
    const download = vi.fn()
    const r = await exportBackup(db, { share: async () => false, download, now })
    expect(r).toBe('downloaded')
    const file = download.mock.calls[0][0]
    expect(file.name).toBe('andata-ritorno-2026-10-23.zip')
    expect(file.type).toBe('application/zip')
    expect(await getMeta(db, 'lastBackupAt')).toBe(now.toISOString())
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
  })
})
