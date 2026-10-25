// Minimal ZIP container I/O over Blobs, so a backup never sits whole in JS memory.
// Writing: entries are stored (level 0) with CRC and sizes in the local headers, and photo
// Blobs go into the output Blob by reference. Reading: the central directory is the index
// and each entry is read on its own slice. No data descriptors and no signature scanning:
// photo bytes may contain ZIP signatures and must never be mistaken for structure.
import { inflateSync, strToU8, strFromU8 } from 'fflate'

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

/** Incremental CRC-32: `crc32(chunk, crc32(prev))`. */
export const crc32 = (bytes, prev = 0) => {
  let c = (prev ^ 0xffffffff) >>> 0
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** Feed a Blob to `fn` chunk by chunk (reader loop: async iteration is missing on older Safari). */
export async function eachChunk(blob, fn) {
  const reader = blob.stream().getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return
    fn(value)
  }
}

/** @returns {Promise<{ size:number, crc32:number }>} */
export async function measure(blob) {
  let size = 0
  let crc = 0
  await eachChunk(blob, (c) => { size += c.length; crc = crc32(c, crc) })
  return { size, crc32: crc }
}

const MAX32 = 0xffffffff
const UTF8 = 0x800 // general purpose flag bit 11: names are UTF-8

function dos(d) {
  const y = Math.min(Math.max(d.getFullYear(), 1980), 2107) - 1980
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: (y << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  }
}

function header(sig, size) {
  const b = new Uint8Array(size)
  const v = new DataView(b.buffer)
  v.setUint32(0, sig, true)
  return { b, v }
}

/**
 * Build a stored ZIP. Each entry's `size`/`crc32` must describe `data` exactly.
 * @param {Array<{ name:string, data:Blob|Uint8Array, size:number, crc32:number }>} entries
 * @param {Date} now
 * @returns {Blob}
 */
export function writeZip(entries, now) {
  if (entries.length > 0xffff) throw new Error('backup-too-large')
  const { time, date } = dos(now)
  const parts = []
  const central = []
  let offset = 0
  for (const e of entries) {
    // Header sizes must match the bytes that follow, or the archive is unreadable.
    if ((e.data.size ?? e.data.length) !== e.size) throw new Error('backup-verify-failed')
    const name = strToU8(e.name)
    // Common local/central fields: version, flags, method 0, time, date, crc, sizes, name length.
    const common = (v, at) => {
      v.setUint16(at, 20, true); v.setUint16(at + 2, UTF8, true); v.setUint16(at + 4, 0, true)
      v.setUint16(at + 6, time, true); v.setUint16(at + 8, date, true); v.setUint32(at + 10, e.crc32, true)
      v.setUint32(at + 14, e.size, true); v.setUint32(at + 18, e.size, true); v.setUint16(at + 22, name.length, true)
    }
    const local = header(0x04034b50, 30 + name.length)
    common(local.v, 4)
    local.b.set(name, 30)
    const cen = header(0x02014b50, 46 + name.length)
    cen.v.setUint16(4, 20, true) // version made by
    common(cen.v, 6)
    cen.v.setUint32(42, offset, true)
    cen.b.set(name, 46)
    parts.push(local.b, e.data)
    central.push(cen.b)
    offset += local.b.length + e.size
    if (offset > MAX32) throw new Error('backup-too-large')
  }
  const cdSize = central.reduce((n, c) => n + c.length, 0)
  if (offset + cdSize > MAX32) throw new Error('backup-too-large')
  const end = header(0x06054b50, 22)
  end.v.setUint16(8, entries.length, true)
  end.v.setUint16(10, entries.length, true)
  end.v.setUint32(12, cdSize, true)
  end.v.setUint32(16, offset, true)
  return new Blob([...parts, ...central, end.b], { type: 'application/zip' })
}

const bytesOf = async (blob) => new Uint8Array(await blob.arrayBuffer())

/**
 * Index a ZIP from its central directory. Throws 'bad-file' when the structure is unusable.
 * @param {Blob} blob
 * @returns {Promise<Map<string, { method:number, crc32:number, csize:number, usize:number, offset:number, flags:number }>>}
 */
export async function readIndex(blob) {
  const tailStart = Math.max(0, blob.size - 22 - 0xffff)
  const tail = await bytesOf(blob.slice(tailStart))
  const tv = new DataView(tail.buffer)
  let at = -1
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tv.getUint32(i, true) === 0x06054b50) { at = i; break }
  }
  if (at < 0) throw new Error('bad-file')
  const count = tv.getUint16(at + 10, true)
  const cdSize = tv.getUint32(at + 12, true)
  const cdOffset = tv.getUint32(at + 16, true)
  if (cdOffset + cdSize > tailStart + at) throw new Error('bad-file') // also rules out ZIP64
  const cd = await bytesOf(blob.slice(cdOffset, cdOffset + cdSize))
  const v = new DataView(cd.buffer)
  const index = new Map()
  let p = 0
  for (let n = 0; n < count; n++) {
    if (p + 46 > cd.length || v.getUint32(p, true) !== 0x02014b50) throw new Error('bad-file')
    const flags = v.getUint16(p + 8, true)
    const nameLen = v.getUint16(p + 28, true)
    const skip = nameLen + v.getUint16(p + 30, true) + v.getUint16(p + 32, true)
    if (p + 46 + skip > cd.length) throw new Error('bad-file')
    const name = strFromU8(cd.subarray(p + 46, p + 46 + nameLen), !(flags & UTF8))
    index.set(name, {
      flags,
      method: v.getUint16(p + 10, true),
      crc32: v.getUint32(p + 16, true),
      csize: v.getUint32(p + 20, true),
      usize: v.getUint32(p + 24, true),
      offset: v.getUint32(p + 42, true),
    })
    p += 46 + skip
  }
  return index
}

/**
 * Feed the uncompressed content of one entry to `fn`, chunk by chunk.
 * Throws 'bad-entry' when this entry alone is unreadable.
 */
async function streamEntry(blob, e, fn) {
  if (e.flags & 1) throw new Error('bad-entry') // encrypted
  const lh = await bytesOf(blob.slice(e.offset, e.offset + 30))
  const lv = new DataView(lh.buffer)
  if (lh.length < 30 || lv.getUint32(0, true) !== 0x04034b50) throw new Error('bad-entry')
  const start = e.offset + 30 + lv.getUint16(26, true) + lv.getUint16(28, true)
  if (start + e.csize > blob.size) throw new Error('bad-entry')
  const data = blob.slice(start, start + e.csize)
  if (e.method === 0) return eachChunk(data, fn)
  if (e.method !== 8) throw new Error('bad-entry')
  let bytes
  try {
    bytes = inflateSync(await bytesOf(data))
  } catch {
    throw new Error('bad-entry')
  }
  fn(bytes)
}

/**
 * The uncompressed content of one entry, as fresh chunks (never a view on the source file,
 * which the browser may stop reading once the user's picked file changes).
 * @returns {Promise<Uint8Array[]>}
 */
export async function readEntry(blob, e) {
  const chunks = []
  await streamEntry(blob, e, (c) => chunks.push(c))
  return chunks
}

/** Size and CRC of a list of chunks. */
export function measureChunks(chunks) {
  let size = 0
  let crc = 0
  for (const c of chunks) { size += c.length; crc = crc32(c, crc) }
  return { size, crc32: crc }
}

/**
 * Read a finished archive back through the reader, one chunk at a time, and check every
 * expected entry. Any failure (unreadable source Blob, short data, wrong CRC) throws
 * 'backup-verify-failed': a backup is only handed out once it has been read back whole.
 * @param {Blob} blob
 * @param {Map<string, { size:number, crc32:number }>} expected  entry name -> content
 */
export async function verifyZip(blob, expected) {
  try {
    const index = await readIndex(blob)
    for (const [name, want] of expected) {
      const e = index.get(name)
      if (!e || e.crc32 !== want.crc32 || e.usize !== want.size) throw new Error('mismatch')
      let size = 0
      let crc = 0
      await streamEntry(blob, e, (c) => { size += c.length; crc = crc32(c, crc) })
      if (size !== want.size || crc !== want.crc32) throw new Error('mismatch')
    }
  } catch {
    throw new Error('backup-verify-failed')
  }
}
