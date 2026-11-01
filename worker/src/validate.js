// Formats of the fields the API accepts; anything else is 400 bad-request.

/** Random ids chosen by clients (family, device, record, photo): 8–64 base64url chars. */
export const ID = /^[A-Za-z0-9_-]{8,64}$/;
/** Small encrypted values (names), base64url. */
export const ENC = /^[A-Za-z0-9_-]{1,4096}$/;
/** SHA-256 hex. */
export const HEX64 = /^[0-9a-f]{64}$/;

/** Opaque secrets sent back by clients (invite token, recovery secret, link token). */
export const isSecret = (s) => typeof s === 'string' && s.length > 0 && s.length <= 128;
