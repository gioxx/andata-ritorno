import { describe, it, expect } from 'vitest'
import { generateKeyRaw, importKey, encrypt, decrypt, encryptJson, decryptJson, b64url, randomToken, sha256Hex } from '../src/sync/crypto.js'
import { encodeRecord, encodeTombstone, decodeRecord, recordAad } from '../src/sync/records.js'

const FAM = 'fam1'
const mkKey = async () => importKey(generateKeyRaw())

describe('b64url', () => {
  it('round-trips every byte value', () => {
    const u8 = Uint8Array.from({ length: 256 }, (_, i) => i)
    const s = b64url.encode(u8)
    expect(s).toMatch(/^[A-Za-z0-9_-]+$/)
    expect([...b64url.decode(s)]).toEqual([...u8])
  })
  it('round-trips lengths 0..5 (padding cases)', () => {
    for (let n = 0; n < 6; n++) {
      const u8 = Uint8Array.from({ length: n }, (_, i) => 250 - i)
      expect([...b64url.decode(b64url.encode(u8))]).toEqual([...u8])
    }
  })
})

describe('crypto', () => {
  it('generates 32-byte keys and 32-byte base64url tokens', () => {
    expect(generateKeyRaw()).toHaveLength(32)
    expect(b64url.decode(randomToken())).toHaveLength(32)
    expect(randomToken()).not.toBe(randomToken())
  })
  it('sha256Hex matches the known vector', async () => {
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })
  it('uses layout iv(12)||ct and a fresh iv each time', async () => {
    const key = await mkKey()
    const pt = new Uint8Array([1, 2, 3])
    const a = await encrypt(key, 'x', pt)
    const b = await encrypt(key, 'x', pt)
    expect(a.length).toBe(12 + 3 + 16)
    expect([...a]).not.toEqual([...b])
    expect([...(await decrypt(key, 'x', a))]).toEqual([1, 2, 3])
  })
  it('rejects wrong key, wrong aad, tampering and short data', async () => {
    const key = await mkKey()
    const data = await encrypt(key, 'a', new Uint8Array([9]))
    await expect(decrypt(await mkKey(), 'a', data)).rejects.toThrow('decrypt-failed')
    await expect(decrypt(key, 'b', data)).rejects.toThrow('decrypt-failed')
    const bad = data.slice(); bad[bad.length - 1] ^= 1
    await expect(decrypt(key, 'a', bad)).rejects.toThrow('decrypt-failed')
    await expect(decrypt(key, 'a', new Uint8Array(5))).rejects.toThrow('decrypt-failed')
  })
  it('encryptJson/decryptJson round-trip', async () => {
    const key = await mkKey()
    const s = await encryptJson(key, 'j', { a: [1, 'è'] })
    expect(await decryptJson(key, 'j', s)).toEqual({ a: [1, 'è'] })
  })
})

describe('records', () => {
  it('builds the record AAD', () => expect(recordAad('f', 'r')).toBe('f:r'))
  it.each([
    ['item', { id: 'i1', title: 'x' }],
    ['tab', { id: 't1', name: 'T' }],
    ['category', { id: 'c1', name: 'C' }],
  ])('round-trips a %s', async (kind, value) => {
    const key = await mkKey()
    const { rid, data } = await encodeRecord(key, FAM, { kind, value, by: 'dev1' })
    expect(rid).toBe(value.id)
    const out = await decodeRecord(key, FAM, { rid, seq: 7, data })
    expect(out).toMatchObject({ rid, seq: 7, kind, value, by: 'dev1' })
    expect(out.tombstone).toBeUndefined()
  })
  it('round-trips a tombstone', async () => {
    const key = await mkKey()
    const { rid, data } = await encodeTombstone(key, FAM, { kind: 'item', id: 'i1', deletedAt: '2026-01-01T00:00:00Z', by: 'd' })
    expect(rid).toBe('i1')
    const out = await decodeRecord(key, FAM, { rid, seq: 3, data })
    expect(out.tombstone).toEqual({ kind: 'item', id: 'i1', deletedAt: '2026-01-01T00:00:00Z' })
    expect(out.value).toBeUndefined()
    expect(out.by).toBe('d')
  })
  it('same plaintext twice gives different ciphertext', async () => {
    const key = await mkKey()
    const args = { kind: 'item', value: { id: 'i1' }, by: 'd' }
    expect((await encodeRecord(key, FAM, args)).data).not.toBe((await encodeRecord(key, FAM, args)).data)
  })
  it('swapping data between rids fails', async () => {
    const key = await mkKey()
    const a = await encodeRecord(key, FAM, { kind: 'item', value: { id: 'a' }, by: 'd' })
    const b = await encodeRecord(key, FAM, { kind: 'item', value: { id: 'b' }, by: 'd' })
    await expect(decodeRecord(key, FAM, { rid: 'a', seq: 1, data: b.data })).rejects.toThrow('decrypt-failed')
    await expect(decodeRecord(key, FAM, { rid: 'b', seq: 1, data: a.data })).rejects.toThrow('decrypt-failed')
  })
  it('wrong key fails', async () => {
    const { rid, data } = await encodeRecord(await mkKey(), FAM, { kind: 'item', value: { id: 'a' }, by: 'd' })
    await expect(decodeRecord(await mkKey(), FAM, { rid, seq: 1, data })).rejects.toThrow('decrypt-failed')
  })
})
