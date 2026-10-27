import { env } from 'cloudflare:workers';
import { describe, it, expect } from 'vitest';
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


const put = (path, bytes, token) =>
  call(path, { method: 'PUT', headers: { 'content-type': 'application/octet-stream', authorization: `Bearer ${token}` }, body: bytes });
const rec = (data = 'AAAA') => ({ rid: rid(), data });
const pull = async (token, since) => (await get(`/api/sync?since=${since}`, token)).json();

/** Insert n filler rows straight into D1 (fast path for cap tests). */
async function seed(familyId, table, n) {
  for (let i = 0; i < n; i += 50) {
    const stmts = [];
    for (let j = i; j < Math.min(n, i + 50); j++) {
      stmts.push(
        table === 'records'
          ? env.DB.prepare('INSERT INTO records (family_id, rid, seq, data) VALUES (?, ?, ?, ?)').bind(familyId, `filler-${j}-xxxx`, j + 1, 'AAAA')
          : env.DB.prepare('INSERT INTO photos (family_id, pid, size, uploaded_at) VALUES (?, ?, 1, ?)').bind(familyId, `filler-${j}-xxxx`, now()),
      );
    }
    await env.DB.batch(stmts);
  }
}

describe('record sync', () => {
  it('requires a device', async () => {
    expect((await get('/api/sync?since=0')).status).toBe(401);
    expect((await post('/api/sync', { records: [] })).status).toBe(401);
  });

  it('pushes records and pulls them in seq order', async () => {
    const f = await newFamily();
    const rs = [rec('AAAA'), rec('BBBB'), rec('CCCC')];
    const res = await post('/api/sync', { records: rs }, f.token);
    expect(res.status).toBe(200);
    expect((await res.json()).seq).toBe(3);
    const page = await pull(f.token, 0);
    expect(page.records.map((r) => r.rid)).toEqual(rs.map((r) => r.rid));
    expect(page.records.map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(page.records[1].data).toBe('BBBB');
    expect(page).toMatchObject({ next: 3, more: false });
    expect(await pull(f.token, 3)).toMatchObject({ records: [], next: 3, more: false });
  });

  it('updates a record in place with a new seq', async () => {
    const f = await newFamily();
    const rs = [rec(), rec()];
    await post('/api/sync', { records: rs }, f.token);
    const res = await post('/api/sync', { records: [{ rid: rs[0].rid, data: 'ZZZZ' }] }, f.token);
    expect((await res.json()).seq).toBe(3);
    const page = await pull(f.token, 2);
    expect(page.records).toEqual([{ rid: rs[0].rid, seq: 3, data: 'ZZZZ' }]);
    expect((await pull(f.token, 0)).records).toHaveLength(2);
  });

  it('pages at 500 records', async () => {
    const f = await newFamily();
    for (const n of [200, 200, 101]) await post('/api/sync', { records: Array.from({ length: n }, () => rec()) }, f.token);
    const first = await pull(f.token, 0);
    expect(first.records).toHaveLength(500);
    expect(first).toMatchObject({ next: 500, more: true });
    const second = await pull(f.token, first.next);
    expect(second.records).toHaveLength(1);
    expect(second).toMatchObject({ next: 501, more: false });
  });

  it('keeps families apart', async () => {
    const a = await newFamily();
    const b = await newFamily();
    const shared = rid();
    await post('/api/sync', { records: [{ rid: shared, data: 'AAAA' }] }, a.token);
    expect((await pull(b.token, 0)).records).toEqual([]);
    await post('/api/sync', { records: [{ rid: shared, data: 'BBBB' }] }, b.token);
    expect((await pull(a.token, 0)).records[0].data).toBe('AAAA');
  });

  it('rejects malformed input and oversize pushes', async () => {
    const f = await newFamily();
    expect((await post('/api/sync', { records: [{ rid: 'x', data: 'AAAA' }] }, f.token)).status).toBe(400);
    expect((await post('/api/sync', { records: [{ rid: rid(), data: 'not base64!' }] }, f.token)).status).toBe(400);
    expect((await post('/api/sync', {}, f.token)).status).toBe(400);
    expect((await get('/api/sync?since=abc', f.token)).status).toBe(400);
    const big = await post('/api/sync', { records: [rec('A'.repeat(64 * 1024 + 1))] }, f.token);
    expect(big.status).toBe(413);
    expect((await big.json()).error).toBe('limit-record-size');
    expect((await post('/api/sync', { records: [rec('A'.repeat(64 * 1024))] }, f.token)).status).toBe(200);
    const many = await post('/api/sync', { records: Array.from({ length: 201 }, () => rec()) }, f.token);
    expect(many.status).toBe(413);
    expect((await many.json()).error).toBe('limit-records');
  });

  it('caps a family at 10 000 distinct records; updates do not count twice', async () => {
    const f = await newFamily();
    await seed(f.familyId, 'records', 9999);
    await env.DB.prepare('UPDATE families SET seq = 9999 WHERE id = ?').bind(f.familyId).run();
    expect((await post('/api/sync', { records: [rec()] }, f.token)).status).toBe(200);
    const over = await post('/api/sync', { records: [rec()] }, f.token);
    expect(over.status).toBe(413);
    expect((await over.json()).error).toBe('limit-records');
    expect((await post('/api/sync', { records: [{ rid: 'filler-0-xxxx', data: 'ZZZZ' }] }, f.token)).status).toBe(200);
  });
});

describe('photos', () => {
  const bytes = (n, v = 7) => new Uint8Array(n).fill(v);

  it('stores, lists, reads and deletes a photo', async () => {
    const f = await newFamily();
    const pid = rid();
    expect((await put(`/api/photos/${pid}`, bytes(10), f.token)).status).toBe(204);
    const list = await (await get('/api/photos', f.token)).json();
    expect(list.photos).toEqual([{ pid, size: 10, uploadedAt: expect.any(String) }]);
    const res = await get(`/api/photos/${pid}`, f.token);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes(10));
    expect((await del(`/api/photos/${pid}`, f.token)).status).toBe(204);
    expect((await get(`/api/photos/${pid}`, f.token)).status).toBe(404);
    expect((await (await get('/api/photos', f.token)).json()).photos).toEqual([]);
    expect(await env.PHOTOS.get(`${f.familyId}/${pid}`)).toBeNull();
  });

  it('replaces a photo in place', async () => {
    const f = await newFamily();
    const pid = rid();
    await put(`/api/photos/${pid}`, bytes(10), f.token);
    await put(`/api/photos/${pid}`, bytes(20, 9), f.token);
    expect((await (await get('/api/photos', f.token)).json()).photos).toMatchObject([{ pid, size: 20 }]);
    expect(new Uint8Array(await (await get(`/api/photos/${pid}`, f.token)).arrayBuffer())).toEqual(bytes(20, 9));
  });

  it('requires a device and a valid pid', async () => {
    const f = await newFamily();
    expect((await get('/api/photos')).status).toBe(401);
    expect((await put(`/api/photos/${rid()}`, bytes(1))).status).toBe(401);
    expect((await put('/api/photos/short', bytes(1), f.token)).status).toBe(400);
  });

  it('keeps families apart', async () => {
    const a = await newFamily();
    const b = await newFamily();
    const pid = rid();
    await put(`/api/photos/${pid}`, bytes(5), a.token);
    expect((await get(`/api/photos/${pid}`, b.token)).status).toBe(404);
    expect((await (await get('/api/photos', b.token)).json()).photos).toEqual([]);
    await del(`/api/photos/${pid}`, b.token);
    expect((await get(`/api/photos/${pid}`, a.token)).status).toBe(200);
  });

  it('rejects photos over 3 MB', async () => {
    const f = await newFamily();
    const ok = await put(`/api/photos/${rid()}`, bytes(3 * 1024 * 1024), f.token);
    expect(ok.status).toBe(204);
    const res = await put(`/api/photos/${rid()}`, bytes(3 * 1024 * 1024 + 1), f.token);
    expect(res.status).toBe(413);
    expect((await res.json()).error).toBe('limit-photo-size');
  });

  it('rejects an oversize Content-Length without reading the body', async () => {
    const f = await newFamily();
    const res = await call(`/api/photos/${rid()}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${f.token}`, 'content-length': String(4 * 1024 * 1024) },
      body: bytes(10),
    });
    expect(res.status).toBe(413);
  });

  it('caps a family at 2 000 photos; replacing does not count twice', async () => {
    const f = await newFamily();
    await seed(f.familyId, 'photos', 2000);
    const res = await put(`/api/photos/${rid()}`, bytes(1), f.token);
    expect(res.status).toBe(413);
    expect((await res.json()).error).toBe('limit-photos');
    expect((await put('/api/photos/filler-0-xxxx', bytes(1), f.token)).status).toBe(204);
  });
});
