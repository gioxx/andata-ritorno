import { env } from 'cloudflare:workers';
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import worker from '../src/index.js';

const DOMAIN = 'team.cloudflareaccess.com';
const AUD = 'aud-for-tests';
const ON = { ACCESS_TEAM_DOMAIN: DOMAIN, ACCESS_AUD: AUD };

const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const part = (obj) => b64url(new TextEncoder().encode(JSON.stringify(obj)));

let keys;
let jwk;
beforeAll(async () => {
  keys = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  jwk = { ...(await crypto.subtle.exportKey('jwk', keys.publicKey)), kid: 'k1', alg: 'RS256' };
});
afterEach(() => vi.restoreAllMocks());

async function token(claims = {}, signer = keys.privateKey) {
  const head = part({ alg: 'RS256', kid: 'k1', typ: 'JWT' });
  const body = part({ aud: [AUD], iss: `https://${DOMAIN}`, exp: Math.floor(Date.now() / 1000) + 300, email: 'owner@example.com', ...claims });
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', signer, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(sig)}`;
}

const mockCerts = () =>
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url === `https://${DOMAIN}/cdn-cgi/access/certs`) return Response.json({ keys: [jwk] });
    throw new Error(`unexpected fetch ${url}`);
  });

const stats = (jwt, extra = ON) => {
  mockCerts();
  const headers = jwt ? { 'cf-access-jwt-assertion': jwt } : {};
  return worker.fetch(new Request('https://ar.test/api/admin/stats', { headers }), { ...env, ...extra }, {});
};

describe('GET /api/admin/stats', () => {
  it('does not exist without the Access settings, even with a valid token', async () => {
    expect((await stats(await token(), {})).status).toBe(404);
  });

  it('looks absent without a valid Access token', async () => {
    const other = await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['sign'],
    );
    for (const jwt of [
      null,
      'not.a.jwt',
      await token({ aud: ['another-app'] }),
      await token({ iss: 'https://evil.example' }),
      await token({ exp: Math.floor(Date.now() / 1000) - 10 }),
      await token({}, other.privateKey),
    ]) {
      expect((await stats(jwt)).status).toBe(404);
    }
  });

  it('answers aggregate numbers only to a valid Access token', async () => {
    await env.DB.prepare("INSERT INTO codes (hash, kind, source, created_at) VALUES ('h-admin-1', 'family', 'stripe', ?)").bind(new Date().toISOString()).run();
    const res = await stats(await token());
    expect(res.status).toBe(200);
    const out = await res.json();
    expect(out).toMatchObject({ families: { total: expect.any(Number) }, devices: { total: expect.any(Number) }, records: expect.any(Number) });
    expect(out.codes.find((c) => c.kind === 'family' && c.source === 'stripe').issued).toBeGreaterThan(0);
    expect(out.salesByMonth[0]).toMatchObject({ month: new Date().toISOString().slice(0, 7) });
    expect(JSON.stringify(out)).not.toMatch(/h-admin-1|name_enc|token_hash|email_hmac/);
  });
});

describe('POST /api/admin/registrations', () => {
  const set = async (body, { jwt, origin = 'https://ar.test', type = 'application/json' } = {}) => {
    mockCerts();
    const headers = { 'content-type': type, ...(origin ? { origin } : {}), ...(jwt ? { 'cf-access-jwt-assertion': jwt } : {}) };
    return worker.fetch(new Request('https://ar.test/api/admin/registrations', { method: 'POST', headers, body: JSON.stringify(body) }), { ...env, ...ON }, {});
  };
  const open = async () => (await (await stats(await token())).json()).registrationsOpen;

  it('closes and reopens registrations, shown in the stats', async () => {
    expect(await open()).toBe(true);
    const res = await set({ open: false }, { jwt: await token() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ registrationsOpen: false });
    expect(await open()).toBe(false);
    expect((await set({ open: true }, { jwt: await token() })).status).toBe(200);
    expect(await open()).toBe(true);
  });

  it('looks absent without a valid token and refuses cross-site or malformed requests', async () => {
    expect((await set({ open: false })).status).toBe(404);
    expect((await set({ open: false }, { jwt: await token(), origin: 'https://evil.example' })).status).toBe(404);
    expect((await set({ open: false }, { jwt: await token(), origin: null })).status).toBe(404);
    expect((await set({ open: false }, { jwt: await token(), type: 'text/plain' })).status).toBe(404);
    expect((await set({ open: 'no' }, { jwt: await token() })).status).toBe(400);
    expect(await open()).toBe(true);
  });
});
