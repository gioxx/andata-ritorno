import { env } from 'cloudflare:workers';
import { describe, it, expect, vi, afterEach } from 'vitest';
import worker from '../src/index.js';
import { sha256Hex } from '../src/auth.js';
import { newCode, hashCode } from '../src/codes.js';

const call = (path, init, extra = {}) => worker.fetch(new Request(`https://ar.test${path}`, init), { ...env, ...extra }, {});
const send = (method, path, body, token) =>
  call(path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const get = (path, token) => send('GET', path, undefined, token);
const post = (path, body, token) => send('POST', path, body, token);
const del = (path, token) => send('DELETE', path, undefined, token);

const rid = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const SECRET = 'recovery-secret-for-tests-0123456789abcdefghij';

/** A redeemed family with one device; returns its ids and that device's token. */
async function newFamily() {
  const code = newCode();
  await env.DB.prepare("INSERT INTO codes (hash, kind, source, created_at) VALUES (?, 'family', 'manual', ?)").bind(await hashCode(code), now()).run();
  const body = {
    code,
    familyId: rid(),
    deviceId: rid(),
    familyNameEnc: 'ZmFtaWx5',
    deviceNameEnc: 'ZGV2aWNlMQ',
    recoveryHash: await sha256Hex(SECRET),
  };
  const res = await post('/api/redeem', body);
  expect(res.status).toBe(200);
  const { token } = await res.json();
  return { familyId: body.familyId, deviceId: body.deviceId, token };
}

async function invite(token) {
  const res = await post('/api/invites', undefined, token);
  expect(res.status).toBe(200);
  return (await res.json()).token;
}

const joinBody = (inviteToken) => ({ inviteToken, deviceId: rid(), deviceNameEnc: 'bmV3' });

/** Fill the family up to its limit (4) through invites; returns the joined devices. */
async function fill(fam) {
  const joined = [];
  for (let i = 0; i < 3; i++) {
    const body = joinBody(await invite(fam.token));
    const res = await post('/api/join', body);
    expect(res.status).toBe(200);
    joined.push({ deviceId: body.deviceId, ...(await res.json()) });
  }
  return joined;
}

const count = async (table, familyId) =>
  (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE family_id = ?`).bind(familyId).first()).n;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('GET /api/family', () => {
  it('describes the family and its devices', async () => {
    const fam = await newFamily();
    const res = await get('/api/family', fam.token);
    expect(res.status).toBe(200);
    const out = await res.json();
    expect(out).toMatchObject({ familyId: fam.familyId, familyNameEnc: 'ZmFtaWx5', deviceLimit: 4, you: fam.deviceId });
    expect(out.devices).toHaveLength(1);
    expect(out.devices[0]).toMatchObject({ id: fam.deviceId, nameEnc: 'ZGV2aWNlMQ' });
    expect(typeof out.devices[0].createdAt).toBe('string');
    expect(typeof out.devices[0].lastSeenAt).toBe('string');
    expect((await get('/api/family')).status).toBe(401);
  });
});

describe('invites and join', () => {
  it('creates an invite, shows its info and joins with it', async () => {
    const fam = await newFamily();
    const res = await post('/api/invites', undefined, fam.token);
    expect(res.status).toBe(200);
    const inv = await res.json();
    expect(inv).toMatchObject({ used: 1, limit: 4 });
    expect(inv.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Date.parse(inv.expiresAt) - Date.now()).toBeGreaterThan(9 * 60 * 1000);
    // Only the hash is stored.
    expect(await env.DB.prepare('SELECT 1 FROM invites WHERE hash = ?').bind(inv.token).first()).toBeNull();
    expect(await env.DB.prepare('SELECT 1 FROM invites WHERE hash = ?').bind(await sha256Hex(inv.token)).first()).not.toBeNull();

    const info = await get(`/api/invites/info?t=${inv.token}`);
    expect(info.status).toBe(200);
    expect(await info.json()).toEqual({ familyNameEnc: 'ZmFtaWx5', used: 1, limit: 4 });

    const body = joinBody(inv.token);
    const join = await post('/api/join', body);
    expect(join.status).toBe(200);
    const out = await join.json();
    expect(out.deviceLimit).toBe(4);
    const fam2 = await (await get('/api/family', out.token)).json();
    expect(fam2.you).toBe(body.deviceId);
    expect(fam2.devices.map((d) => d.id).sort()).toEqual([fam.deviceId, body.deviceId].sort());
  });

  it('refuses an invite used twice', async () => {
    const fam = await newFamily();
    const t = await invite(fam.token);
    expect((await post('/api/join', joinBody(t))).status).toBe(200);
    const again = await post('/api/join', joinBody(t));
    expect(again.status).toBe(410);
    expect(await again.json()).toEqual({ error: 'invite-expired' });
    expect((await get(`/api/invites/info?t=${t}`)).status).toBe(410);
  });

  it('lets a retried join recover its token while the invite is fresh', async () => {
    const fam = await newFamily();
    const body = joinBody(await invite(fam.token));
    const first = await (await post('/api/join', body)).json();
    const retry = await post('/api/join', body);
    expect(retry.status).toBe(200);
    const out = await retry.json();
    expect(out.token).not.toBe(first.token);
    expect((await get('/api/family', first.token)).status).toBe(401);
    expect((await get('/api/family', out.token)).status).toBe(200);
    expect(await count('devices', fam.familyId)).toBe(2);
  });

  it('refuses an invite after 10 minutes', async () => {
    const fam = await newFamily();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2030-01-01T10:00:00Z'));
    const t = await invite(fam.token);
    vi.setSystemTime(new Date('2030-01-01T10:09:59Z'));
    expect((await get(`/api/invites/info?t=${t}`)).status).toBe(200);
    vi.setSystemTime(new Date('2030-01-01T10:10:00Z'));
    expect((await get(`/api/invites/info?t=${t}`)).status).toBe(410);
    const res = await post('/api/join', joinBody(t));
    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({ error: 'invite-expired' });
  });

  it('creating an invite deletes the expired invites of that family', async () => {
    const fam = await newFamily();
    const other = await newFamily();
    const past = new Date(Date.now() - 60 * 1000).toISOString();
    for (const [h, f] of [['expired-own', fam.familyId], ['expired-other', other.familyId]]) {
      await env.DB.prepare('INSERT INTO invites (hash, family_id, expires_at) VALUES (?, ?, ?)').bind(h, f, past).run();
    }
    await invite(fam.token);
    expect(await env.DB.prepare("SELECT 1 FROM invites WHERE hash = 'expired-own'").first()).toBeNull();
    expect(await env.DB.prepare("SELECT 1 FROM invites WHERE hash = 'expired-other'").first()).not.toBeNull();
    expect(await count('invites', fam.familyId)).toBe(1);
  });

  it('refuses unknown or malformed invite tokens', async () => {
    expect((await get('/api/invites/info?t=nope')).status).toBe(410);
    expect((await get('/api/invites/info')).status).toBe(410);
    expect((await post('/api/join', joinBody('nope'))).status).toBe(410);
    expect((await post('/api/join', { inviteToken: 'x', deviceId: 'bad id', deviceNameEnc: 'bmV3' })).status).toBe(400);
  });

  it('refuses invites and joins when the family is full', async () => {
    const fam = await newFamily();
    // An invite made while a slot was free cannot be used once the family is full.
    const late = await invite(fam.token);
    await fill(fam);
    const res = await post('/api/invites', undefined, fam.token);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'family-full' });
    const join = await post('/api/join', joinBody(late));
    expect(join.status).toBe(409);
    expect(await join.json()).toEqual({ error: 'family-full' });
    expect(await count('devices', fam.familyId)).toBe(4);
  });

  it('lets exactly one of two concurrent joins take the last slot', async () => {
    const fam = await newFamily();
    for (let i = 0; i < 2; i++) expect((await post('/api/join', joinBody(await invite(fam.token)))).status).toBe(200);
    const [a, b] = [await invite(fam.token), await invite(fam.token)];
    const results = await Promise.all([post('/api/join', joinBody(a)), post('/api/join', joinBody(b))]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await count('devices', fam.familyId)).toBe(4);
  });

  it('rate-limits invite info and join with the strict bucket', async () => {
    const RL_STRICT = { limit: async () => ({ success: false }) };
    expect((await call('/api/invites/info?t=x', undefined, { RL_STRICT })).status).toBe(429);
    const res = await call('/api/join', { method: 'POST', body: JSON.stringify(joinBody('x')) }, { RL_STRICT });
    expect(res.status).toBe(429);
  });
});

describe('DELETE /api/devices/:id', () => {
  it('removes another device: its token stops working and the slot frees up', async () => {
    const fam = await newFamily();
    const [other] = await fill(fam);
    expect((await post('/api/invites', undefined, fam.token)).status).toBe(409);
    const res = await del(`/api/devices/${other.deviceId}`, fam.token);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ purged: false });
    expect((await get('/api/family', other.token)).status).toBe(401);
    expect((await post('/api/invites', undefined, fam.token)).status).toBe(200);
  });

  it('cannot remove a device of another family', async () => {
    const a = await newFamily();
    const b = await newFamily();
    const res = await del(`/api/devices/${b.deviceId}`, a.token);
    expect(res.status).toBe(404);
    expect((await get('/api/family', b.token)).status).toBe(200);
  });

  it('leaving keeps the family while other devices remain', async () => {
    const fam = await newFamily();
    const [other] = await fill(fam);
    const res = await del(`/api/devices/${other.deviceId}`, other.token);
    expect(await res.json()).toEqual({ purged: false });
    expect((await get('/api/family', fam.token)).status).toBe(200);
  });

  it('keeps the family when two devices remove each other at once', async () => {
    const fam = await newFamily();
    const body = joinBody(await invite(fam.token));
    const other = { deviceId: body.deviceId, ...(await (await post('/api/join', body)).json()) };
    await env.DB.prepare("INSERT INTO records (family_id, rid, seq, data) VALUES (?, 'r1', 1, 'x')").bind(fam.familyId).run();
    const results = await Promise.all([del(`/api/devices/${other.deviceId}`, fam.token), del(`/api/devices/${fam.deviceId}`, other.token)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 404]);
    expect(await results.find((r) => r.status === 200).json()).toEqual({ purged: false });
    expect(await count('devices', fam.familyId)).toBe(1);
    expect(await count('records', fam.familyId)).toBe(1);
    expect(await env.DB.prepare('SELECT 1 FROM families WHERE id = ?').bind(fam.familyId).first()).not.toBeNull();
  });

  it('purges exactly once when the last two devices leave at once', async () => {
    const fam = await newFamily();
    const body = joinBody(await invite(fam.token));
    const other = { deviceId: body.deviceId, ...(await (await post('/api/join', body)).json()) };
    const results = await Promise.all([del(`/api/devices/${fam.deviceId}`, fam.token), del(`/api/devices/${other.deviceId}`, other.token)]);
    const outs = await Promise.all(results.map((r) => r.json()));
    expect(outs.map((o) => o.purged).sort()).toEqual([false, true]);
    expect(await env.DB.prepare('SELECT 1 FROM families WHERE id = ?').bind(fam.familyId).first()).toBeNull();
  });

  it('answers 404 for an unknown device without touching the family', async () => {
    const fam = await newFamily();
    await env.DB.prepare("INSERT INTO records (family_id, rid, seq, data) VALUES (?, 'r1', 1, 'x')").bind(fam.familyId).run();
    const res = await del(`/api/devices/${rid()}`, fam.token);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not-found' });
    expect(await count('devices', fam.familyId)).toBe(1);
    expect(await count('records', fam.familyId)).toBe(1);
  });

  it('purges the family when the last device leaves, keeping the licence', async () => {
    const fam = await newFamily();
    const { licence_id: licenceId } = await env.DB.prepare('SELECT licence_id FROM families WHERE id = ?').bind(fam.familyId).first();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO records (family_id, rid, seq, data) VALUES (?, 'r1', 1, 'x')").bind(fam.familyId),
      env.DB.prepare("INSERT INTO photos (family_id, pid, size, uploaded_at) VALUES (?, 'p1', 3, ?)").bind(fam.familyId, now()),
    ]);
    await invite(fam.token);
    await env.PHOTOS.put(`${fam.familyId}/p1`, 'abc');

    const res = await del(`/api/devices/${fam.deviceId}`, fam.token);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ purged: true });
    for (const table of ['records', 'photos', 'invites', 'devices']) expect(await count(table, fam.familyId), table).toBe(0);
    expect(await env.DB.prepare('SELECT 1 FROM families WHERE id = ?').bind(fam.familyId).first()).toBeNull();
    expect(await env.PHOTOS.get(`${fam.familyId}/p1`)).toBeNull();
    const lic = await env.DB.prepare('SELECT family_id FROM licences WHERE id = ?').bind(licenceId).first();
    expect(lic).toEqual({ family_id: null });
  });
});

describe('recovery kit', () => {
  const recoverBody = (fam, extra = {}) => ({ familyId: fam.familyId, recoverySecret: SECRET, deviceId: rid(), deviceNameEnc: 'a2l0', ...extra });

  it('adds a device with the right secret', async () => {
    const fam = await newFamily();
    const body = recoverBody(fam);
    const res = await post('/api/recover', body);
    expect(res.status).toBe(200);
    const out = await res.json();
    expect(out.deviceLimit).toBe(4);
    expect((await (await get('/api/family', out.token)).json()).you).toBe(body.deviceId);
    // A retry with the same device id replaces its token instead of taking another slot.
    const retry = await (await post('/api/recover', body)).json();
    expect((await get('/api/family', out.token)).status).toBe(401);
    expect((await get('/api/family', retry.token)).status).toBe(200);
    expect(await count('devices', fam.familyId)).toBe(2);
  });

  it('answers a wrong secret and an unknown family the same way', async () => {
    const fam = await newFamily();
    for (const body of [recoverBody(fam, { recoverySecret: 'wrong' }), recoverBody({ familyId: rid() })]) {
      const res = await post('/api/recover', body);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'bad-kit' });
      const rm = await post('/api/recover/remove-device', { familyId: body.familyId, recoverySecret: body.recoverySecret, deviceId: fam.deviceId });
      expect(rm.status).toBe(403);
      expect(await rm.json()).toEqual({ error: 'bad-kit' });
    }
    expect(await count('devices', fam.familyId)).toBe(1);
  });

  it('lists the devices when full; removing one with the kit lets recovery in', async () => {
    const fam = await newFamily();
    const joined = await fill(fam);
    const body = recoverBody(fam);
    const full = await post('/api/recover', body);
    expect(full.status).toBe(409);
    const out = await full.json();
    expect(out.error).toBe('family-full');
    expect(out.devices).toHaveLength(4);
    expect(out.devices[0]).toEqual({ id: expect.any(String), nameEnc: expect.any(String), createdAt: expect.any(String), lastSeenAt: expect.any(String) });

    const rm = await post('/api/recover/remove-device', { familyId: fam.familyId, recoverySecret: SECRET, deviceId: joined[0].deviceId });
    expect(rm.status).toBe(200);
    expect(await rm.json()).toEqual({ ok: true });
    expect((await get('/api/family', joined[0].token)).status).toBe(401);
    expect((await post('/api/recover', body)).status).toBe(200);
  });

  it('lets exactly one of two concurrent recoveries take the last slot', async () => {
    const fam = await newFamily();
    for (let i = 0; i < 2; i++) expect((await post('/api/recover', recoverBody(fam))).status).toBe(200);
    const results = await Promise.all([post('/api/recover', recoverBody(fam)), post('/api/recover', recoverBody(fam))]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await count('devices', fam.familyId)).toBe(4);
  });

  it('rate-limits recovery with the strict bucket', async () => {
    const RL_STRICT = { limit: async () => ({ success: false }) };
    for (const path of ['/api/recover', '/api/recover/remove-device']) {
      const res = await call(path, { method: 'POST', body: '{}' }, { RL_STRICT });
      expect(res.status).toBe(429);
    }
  });
});
