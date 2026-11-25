import { env } from 'cloudflare:workers';
import { describe, it, expect, vi, afterEach } from 'vitest';
import worker from '../src/index.js';
import { newCode, hashCode } from '../src/codes.js';
import { addYear } from '../src/licence.js';
import { purgeExpired, EXPIRED_KEEP_DAYS } from '../src/store.js';
import { STRIPE_VERSION } from '../src/stripe.js';

const SECRETS = {
  STRIPE_SECRET_KEY: 'sk_test_x',
  CODE_HMAC_KEY: 'code-key',
  EMAIL_HMAC_KEY: 'email-key',
  PRICE_FAMILY: 'price_year',
  PRICE_FAMILY_LIFETIME: 'price_lifetime',
  PRICE_SLOT: 'price_slot',
  APP_ORIGIN: 'https://ar.test',
};
const call = (path, init) => worker.fetch(new Request(`https://ar.test${path}`, init), { ...env, ...SECRETS }, {});
const post = (path, body, token) =>
  call(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
const get = (path, token) => call(path, { headers: { authorization: `Bearer ${token}` } });
const rid = () => crypto.randomUUID();
const DAY = 864e5;

async function insertCode(kind, term = null) {
  const code = newCode();
  await env.DB.prepare("INSERT INTO codes (hash, kind, term, source, created_at) VALUES (?, ?, ?, 'manual', ?)")
    .bind(await hashCode(code), kind, term, new Date().toISOString())
    .run();
  return code;
}

/** A new family from a code; returns its first device token and ids. */
async function newFamily(term = 'year') {
  const familyId = rid();
  const res = await post('/api/redeem', {
    code: await insertCode('family', term),
    familyId,
    deviceId: rid(),
    familyNameEnc: 'ZmFtaWx5',
    deviceNameEnc: 'ZGV2aWNl',
    recoveryHash: 'a'.repeat(64),
  });
  expect(res.status).toBe(200);
  const { token } = await res.json();
  const { licence_id: licenceId } = await env.DB.prepare('SELECT licence_id FROM families WHERE id = ?').bind(familyId).first();
  return { token, familyId, licenceId };
}

const setExpiry = (licenceId, iso) => env.DB.prepare('UPDATE licences SET expires_at = ? WHERE id = ?').bind(iso, licenceId).run();
const expiryOf = async (licenceId) => (await env.DB.prepare('SELECT expires_at FROM licences WHERE id = ?').bind(licenceId).first()).expires_at;

afterEach(() => vi.restoreAllMocks());

describe('addYear', () => {
  it('adds one calendar year', () => {
    expect(addYear('2026-11-25T10:00:00.000Z')).toBe('2027-11-25T10:00:00.000Z');
    expect(addYear('2028-02-29T00:00:00.000Z')).toBe('2029-03-01T00:00:00.000Z');
  });
});

describe('yearly licence', () => {
  it('a yearly code gives a licence ending in a year; a lifetime code never ends', async () => {
    const before = Date.now();
    const year = await newFamily('year');
    const end = Date.parse(await expiryOf(year.licenceId));
    expect(end).toBeGreaterThanOrEqual(Date.parse(addYear(new Date(before).toISOString())));
    expect(end - before).toBeLessThan(367 * DAY);
    const life = await newFamily(null);
    expect(await expiryOf(life.licenceId)).toBeNull();

    const fam = await (await get('/api/family', year.token)).json();
    expect(fam.expiresAt).toBe(await expiryOf(year.licenceId));
    expect((await (await get('/api/family', life.token)).json()).expiresAt).toBeNull();
  });

  it('stops sync, photos, invites and seats once expired; family info and renewal still work', async () => {
    const { token, licenceId } = await newFamily('year');
    expect((await get('/api/sync?since=0', token)).status).toBe(200);
    const past = new Date(Date.now() - DAY).toISOString();
    await setExpiry(licenceId, past);
    for (const res of [
      await get('/api/sync?since=0', token),
      await get('/api/photos', token),
      await post('/api/invites', {}, token),
      await post('/api/slot', { code: await insertCode('slot') }, token),
    ]) {
      expect(res.status).toBe(402);
      expect(await res.json()).toEqual({ error: 'licence-expired', expiresAt: past });
    }
    expect((await get('/api/family', token)).status).toBe(200);
    const renewed = await post('/api/renew', { code: await insertCode('family', 'year') }, token);
    expect(renewed.status).toBe(200);
    expect((await get('/api/sync?since=0', token)).status).toBe(200);
  });
});

describe('POST /api/renew', () => {
  it('adds a year to a running licence, from today to an expired one', async () => {
    const { token, licenceId } = await newFamily('year');
    const running = '2099-01-10T00:00:00.000Z';
    await setExpiry(licenceId, running);
    const res = await post('/api/renew', { code: await insertCode('family', 'year') }, token);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ expiresAt: '2100-01-10T00:00:00.000Z' });

    await setExpiry(licenceId, '2020-01-01T00:00:00.000Z');
    const before = Date.now();
    const out = await (await post('/api/renew', { code: await insertCode('family', 'year') }, token)).json();
    expect(Date.parse(out.expiresAt)).toBeGreaterThanOrEqual(Date.parse(addYear(new Date(before).toISOString())));
  });

  it('is idempotent on the same licence and refuses a code used elsewhere', async () => {
    const a = await newFamily('year');
    const b = await newFamily('year');
    const code = await insertCode('family', 'year');
    const first = await (await post('/api/renew', { code }, a.token)).json();
    const again = await post('/api/renew', { code }, a.token);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(first);
    const other = await post('/api/renew', { code }, b.token);
    expect(other.status).toBe(409);
    expect(await other.json()).toEqual({ error: 'code-used' });
  });

  it('a lifetime code makes the licence lifetime; a lifetime licence has nothing to renew', async () => {
    const { token, licenceId } = await newFamily('year');
    expect((await post('/api/renew', { code: await insertCode('family', null) }, token)).status).toBe(200);
    expect(await expiryOf(licenceId)).toBeNull();
    const res = await post('/api/renew', { code: await insertCode('family', 'year') }, token);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'licence-lifetime' });
  });

  it('refuses slot codes, unknown codes and missing tokens', async () => {
    const { token } = await newFamily('year');
    expect(await (await post('/api/renew', { code: await insertCode('slot') }, token)).json()).toEqual({ error: 'code-is-slot' });
    expect((await post('/api/renew', { code: newCode() }, token)).status).toBe(404);
    expect((await post('/api/renew', { code: await insertCode('family', 'year') })).status).toBe(401);
  });

  it('counts two concurrent renewals of one licence as two years at most, never one lost silently', async () => {
    const { token, licenceId } = await newFamily('year');
    await setExpiry(licenceId, '2099-01-10T00:00:00.000Z');
    const results = await Promise.all([
      post('/api/renew', { code: await insertCode('family', 'year') }, token),
      post('/api/renew', { code: await insertCode('family', 'year') }, token),
    ]);
    const ok = results.filter((r) => r.status === 200).length;
    expect(await expiryOf(licenceId)).toBe(ok === 2 ? '2101-01-10T00:00:00.000Z' : '2100-01-10T00:00:00.000Z');
  });
});

describe('Stripe purchase terms', () => {
  function mockStripe(price) {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input.url);
      if (url.hostname !== 'api.stripe.com') throw new Error(`unexpected fetch ${url}`);
      expect(new Headers(init?.headers).get('stripe-version')).toBe(STRIPE_VERSION);
      const id = decodeURIComponent(url.pathname.split('/').pop());
      return Response.json({ id, object: 'checkout.session', payment_status: 'paid', customer_details: { email: null }, line_items: { object: 'list', data: [{ price: { id: price } }] } });
    });
  }

  it('the current family price sells a year, the old one still a lifetime code', async () => {
    for (const [price, term] of [['price_year', 'year'], ['price_lifetime', null], ['price_slot', null]]) {
      mockStripe(price);
      const id = `cs_test_${price}`;
      const out = await (await call(`/api/unlock/session?id=${id}`)).json();
      expect(out.term).toBe(term);
      const row = await env.DB.prepare('SELECT term FROM codes WHERE stripe_session = ?').bind(id).first();
      expect(row.term).toBe(term);
      vi.restoreAllMocks();
    }
  });
});

describe('purgeExpired', () => {
  it('deletes the server copy only after the keep period, and keeps the licence', async () => {
    const old = await newFamily('year');
    const recent = await newFamily('year');
    const life = await newFamily(null);
    await setExpiry(old.licenceId, new Date(Date.now() - (EXPIRED_KEEP_DAYS + 1) * DAY).toISOString());
    await setExpiry(recent.licenceId, new Date(Date.now() - (EXPIRED_KEEP_DAYS - 1) * DAY).toISOString());
    await purgeExpired({ ...env, ...SECRETS });
    const fam = (id) => env.DB.prepare('SELECT 1 AS x FROM families WHERE id = ?').bind(id).first();
    expect(await fam(old.familyId)).toBeNull();
    expect(await fam(recent.familyId)).not.toBeNull();
    expect(await fam(life.familyId)).not.toBeNull();
    const lic = await env.DB.prepare('SELECT family_id FROM licences WHERE id = ?').bind(old.licenceId).first();
    expect(lic).toEqual({ family_id: null });
    expect((await get('/api/family', old.token)).status).toBe(401);
  });
});
