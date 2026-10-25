// End-to-end encryption primitives: AES-GCM 256, layout iv(12) || ciphertext+tag.
// The AAD binds each ciphertext to its slot so the server cannot swap records.
const subtle = globalThis.crypto.subtle
const IV_LEN = 12
const enc = new TextEncoder()
const dec = new TextDecoder()

export const b64url = {
  /** @param {Uint8Array} u8 */
  encode(u8) {
    let s = ''
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000))
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  },
  /** @param {string} str */
  decode(str) {
    const b = atob(str.replace(/-/g, '+').replace(/_/g, '/'))
    return Uint8Array.from(b, (c) => c.charCodeAt(0))
  },
}

export const generateKeyRaw = () => globalThis.crypto.getRandomValues(new Uint8Array(32))

/** 32 random bytes, base64url: device/invite/recovery/licence-link tokens. */
export const randomToken = () => b64url.encode(generateKeyRaw())

export const importKey = (raw) => subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt'])

export async function encrypt(key, aad, bytes) {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_LEN))
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, key, bytes))
  const out = new Uint8Array(IV_LEN + ct.length)
  out.set(iv)
  out.set(ct, IV_LEN)
  return out
}

export async function decrypt(key, aad, data) {
  try {
    if (data.length < IV_LEN + 16) throw new Error('short')
    const iv = data.subarray(0, IV_LEN)
    return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, key, data.subarray(IV_LEN)))
  } catch {
    throw new Error('decrypt-failed')
  }
}

export async function encryptJson(key, aad, obj) {
  return b64url.encode(await encrypt(key, aad, enc.encode(JSON.stringify(obj))))
}

export async function decryptJson(key, aad, b64) {
  let bytes
  try { bytes = b64url.decode(b64) } catch { throw new Error('decrypt-failed') }
  return JSON.parse(dec.decode(await decrypt(key, aad, bytes)))
}

export async function sha256Hex(str) {
  const h = new Uint8Array(await subtle.digest('SHA-256', enc.encode(str)))
  return [...h].map((b) => b.toString(16).padStart(2, '0')).join('')
}
