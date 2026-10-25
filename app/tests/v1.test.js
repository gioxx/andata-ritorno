import { describe, it, expect } from 'vitest'
import { parseV1, detectFormat } from '../src/backup/v1.js'
import sample from './fixtures/v1-sample.json'

const NOW = '2026-10-23T10:00:00.000Z'
const EPOCH = '1970-01-01T00:00:00.000Z'
const clone = () => structuredClone(sample)
const fileOf = (parts, name = 'b.json') => new File(parts, name)

describe('parseV1', () => {
  it('creates Nido and Materna tabs and maps items to them', async () => {
    const inc = await parseV1(clone(), { childMap: {}, now: NOW })
    expect(inc.tabs.map((t) => t.name)).toEqual(['Nido', 'Materna'])
    expect(inc.tabs.map((t) => t.order)).toEqual([0, 1])
    expect(inc.tabs[0]).toMatchObject({ createdAt: NOW, updatedAt: NOW })
    const [nido, materna] = inc.tabs
    expect(inc.childMap).toEqual({ nido: nido.id, materna: materna.id })
    expect(inc.items.map((i) => i.tabId)).toEqual([nido.id, nido.id, materna.id])
    expect(inc.failures).toEqual([])
    expect(inc.photos.size).toBe(3)
    for (const it of inc.items) expect(inc.photos.get(it.photoId)).toBeInstanceOf(Blob)
  })

  it('v1 items never beat a v2 edit: updatedAt is the epoch, createdAt = movedAt', async () => {
    const inc = await parseV1(clone(), { childMap: {}, now: NOW })
    const src = sample.items[0]
    expect(inc.items[0]).toEqual({
      id: src.id, tabId: inc.tabs[0].id, location: 'school', label: src.label,
      photoId: inc.items[0].photoId, createdAt: src.movedAt, movedAt: src.movedAt, updatedAt: EPOCH,
    })
  })

  it('reuses mapped tabs and only creates tabs for "new" or unmapped children', async () => {
    const tabs = [{ id: 'S', name: 'Nido di Sofia', order: 4, createdAt: NOW, updatedAt: NOW }]
    const inc = await parseV1(clone(), { childMap: { nido: 'S', materna: 'new' }, now: NOW, tabs })
    expect(inc.tabs).toHaveLength(1)
    expect(inc.tabs[0]).toMatchObject({ name: 'Materna', order: 5 })
    expect(inc.childMap).toEqual({ nido: 'S', materna: inc.tabs[0].id })
    expect(inc.items.map((i) => i.tabId)).toEqual(['S', 'S', inc.tabs[0].id])
  })

  it('reports every invalid item with a reason, never drops it silently', async () => {
    const data = clone()
    const good = data.items[0]
    data.items.push(
      { ...good, id: 'x1', photo: 'data:image/webp;base64,@@not base64@@' }, // raw atob error
      { ...good, id: 'x2', photo: 'data:image/webp;base64,' }, // empty blob
      { ...good, id: 'x3', photo: undefined },
      { ...good, id: 'x4', location: 'nonna' },
      { ...good, id: undefined, label: 'senza id' },
      { ...good, id: 'x6', child: undefined },
      null,
    )
    const inc = await parseV1(data, { childMap: {}, now: NOW })
    expect(inc.items).toHaveLength(3)
    expect(inc.failures.map((f) => [f.itemId, f.reason])).toEqual([
      ['x1', 'unreadable-photo'],
      ['x2', 'unreadable-photo'],
      ['x3', 'unreadable-photo'],
      ['x4', 'unknown-place'],
      ['', 'incomplete'],
      ['x6', 'incomplete'],
      ['', 'incomplete'],
    ])
    expect(inc.failures[0]).toEqual({
      itemId: 'x1', label: good.label, tabName: 'Nido', location: 'school', reason: 'unreadable-photo',
    })
  })

  it('does not create a tab whose items all failed', async () => {
    const data = clone()
    data.items[2].photo = 'data:image/webp;base64,'
    const inc = await parseV1(data, { childMap: {}, now: NOW })
    expect(inc.tabs.map((t) => t.name)).toEqual(['Nido'])
    expect(inc.childMap).toEqual({ nido: inc.tabs[0].id })
    expect(inc.failures[0]).toMatchObject({ tabName: 'Materna', label: 'Felpa blu' })
  })

  it('new tabs: Nido, then Materna, then other children alphabetically, whatever the file order', async () => {
    const data = clone()
    const good = data.items[0]
    data.items = [
      { ...good, id: 'z', child: 'zeta' },
      { ...data.items[2] },
      { ...good, id: 'a', child: 'alfa' },
      { ...good },
    ]
    const inc = await parseV1(data, { childMap: {}, now: NOW, tabs: [{ id: 'L', name: 'L', order: 2, createdAt: NOW, updatedAt: NOW }] })
    expect(inc.tabs.map((t) => [t.name, t.order])).toEqual([['Nido', 3], ['Materna', 4], ['alfa', 5], ['zeta', 6]])
  })

  it('rejects a file without an items array', async () => {
    await expect(parseV1({ app: 'andata-ritorno', version: 1 }, { childMap: {}, now: NOW })).rejects.toThrow('bad-file')
  })
})

describe('detectFormat', () => {
  it('detects v1 JSON, ZIP and unknown files', async () => {
    expect(await detectFormat(fileOf([JSON.stringify(sample)]))).toBe('v1')
    expect(await detectFormat(fileOf([new Uint8Array([0x50, 0x4b, 3, 4, 0, 0])], 'b.zip'))).toBe('v2')
    expect(await detectFormat(fileOf([JSON.stringify({ app: 'andata-ritorno', version: 2 })]))).toBe('unknown')
    expect(await detectFormat(fileOf([JSON.stringify({ app: 'altro', version: 1 })]))).toBe('unknown')
    expect(await detectFormat(fileOf(['not json']))).toBe('unknown')
    expect(await detectFormat(fileOf([]))).toBe('unknown')
  })
})
