import { describe, it, expect, vi } from 'vitest'
import { openDb, getMeta, setMeta, putTab, addItems } from '../src/db.js'

// The archive's parts become unreadable once streamed (a lazily read IndexedDB Blob failing
// late, as iOS can): headers still read fine, entry data errors after its first chunk.
let breakStreams = false
vi.mock('../src/backup/zipio.js', async (orig) => {
  const m = await orig()
  const faulty = (blob) => ({
    size: blob.size,
    type: blob.type,
    slice: (a, b) => {
      const part = blob.slice(a, b)
      return {
        size: part.size,
        arrayBuffer: () => part.arrayBuffer(),
        stream: () => new ReadableStream({
          start(c) { c.enqueue(new Uint8Array([1])); c.error(new Error('NotReadableError')) },
        }),
      }
    },
  })
  return { ...m, writeZip: (...args) => (breakStreams ? faulty(m.writeZip(...args)) : m.writeZip(...args)) }
})
const { exportBackup } = await import('../src/backup/exporter.js')
const { writeZip } = await import('../src/backup/zipio.js')

const T = '2026-02-01T00:00:00.000Z'
async function seeded() {
  const db = await openDb('ar-verify-' + crypto.randomUUID())
  await putTab(db, { id: 't', name: 'Nido', order: 0, createdAt: T, updatedAt: T })
  await addItems(db,
    [{ id: 'i', tabId: 't', location: 'school', label: 'x', photoId: 'p', createdAt: T, movedAt: T, updatedAt: T }],
    [{ id: 'p', blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/webp' }), width: 1, height: 1 }])
  await setMeta(db, 'unsavedCount', 5)
  return db
}

describe('backup verification', () => {
  it('an archive that cannot be read back is never handed out and meta stays untouched', async () => {
    const db = await seeded()
    const share = vi.fn(async () => true)
    const download = vi.fn()
    breakStreams = true
    try {
      await expect(exportBackup(db, { share, download })).rejects.toThrow('backup-verify-failed')
    } finally { breakStreams = false }
    expect(share).not.toHaveBeenCalled()
    expect(download).not.toHaveBeenCalled()
    expect(await getMeta(db, 'unsavedCount')).toBe(5)
    expect(await getMeta(db, 'lastBackupAt')).toBeUndefined()
  })

  it('a healthy archive passes verification', async () => {
    const db = await seeded()
    expect(await exportBackup(db, { share: async () => true })).toBe('shared')
  })

  it('writeZip refuses an entry whose data does not match its declared size', () => {
    expect(() => writeZip([{ name: 'a', data: new Uint8Array(3), size: 4, crc32: 0 }], new Date())).toThrow('backup-verify-failed')
    expect(() => writeZip([{ name: 'a', data: new Blob(['abc']), size: 2, crc32: 0 }], new Date())).toThrow('backup-verify-failed')
  })
})
