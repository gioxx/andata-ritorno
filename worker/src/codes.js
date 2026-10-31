import { sha256Hex } from './auth.js';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

// 256 is a multiple of 32, so `byte & 31` picks every symbol with equal probability.
const format = (bytes) => {
  const s = [...bytes.slice(0, 12)].map((b) => ALPHABET[b & 31]).join('');
  return `AR-${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
};

/** A fresh unlock code: `AR-XXXX-XXXX-XXXX`, 12 random Crockford symbols (60 bits). */
export function newCode() {
  return format(crypto.getRandomValues(new Uint8Array(12)));
}

/**
 * The code a Stripe Checkout Session pays for, derived instead of stored so the /unlock page and the
 * webhook produce the same plaintext while D1 keeps only its hash.
 * @param {string} key CODE_HMAC_KEY
 * @param {string} sessionId
 */
export async function codeFromHmac(key, sessionId) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return format(new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(sessionId))));
}

/**
 * Canonical `AR-XXXX-XXXX-XXXX` form of user input, or null if it cannot be a code.
 * Uppercases, drops spaces/dashes, reads O as 0 and I/L as 1; the `AR` prefix is optional.
 */
export function normaliseCode(input) {
  if (typeof input !== 'string' || input.length > 64) return null;
  let s = input.toUpperCase().replace(/[\s-]/g, '');
  if (s.length === 14 && s.startsWith('AR')) s = s.slice(2);
  s = s.replace(/O/g, '0').replace(/[IL]/g, '1');
  if (s.length !== 12 || [...s].some((c) => !ALPHABET.includes(c))) return null;
  return `AR-${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
}

/** SHA-256 hex of the canonical code (what D1 stores). */
export async function hashCode(code) {
  return sha256Hex(normaliseCode(code) ?? code);
}
