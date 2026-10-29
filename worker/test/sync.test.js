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

describe('streamed bodies without Content-Length', () => {
  const stream = (n) => {
    let sent = 0;
    return new ReadableStream({
      pull(c) {
        if (sent >= n) return c.close();
        const k = Math.min(64 * 1024, n - sent);
        sent += k;
        c.enqueue(new Uint8Array(k));
      },
    });
  };
  const streamed = (path, n, token) =>
    call(path, { method: path.includes('photos') ? 'PUT' : 'POST', headers: { authorization: `Bearer ${token}` }, body: stream(n), duplex: 'half' });

  it('rejects a photo over 3 MB', async () => {
    const f = await newFamily();
    const res = await streamed(`/api/photos/${rid()}`, 3 * 1024 * 1024 + 1, f.token);
    expect(res.status).toBe(413);
    expect((await res.json()).error).toBe('limit-photo-size');
  });

  it('rejects a JSON body over its cap', async () => {
    const f = await newFamily();
    const res = await streamed('/api/sync', 200 * (64 * 1024 + 128) + 1, f.token);
    expect(res.status).toBe(413);
    expect((await res.json()).error).toBe('too-large');
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

  const total = async () => (await env.DB.prepare("SELECT bytes FROM usage WHERE key = 'photo_bytes'").first()).bytes;
  const withCap = (cap) => ({ MAX_TOTAL_PHOTO_BYTES: String(cap) });
  const putCap = (path, data, token, cap) =>
    call(path, { method: 'PUT', headers: { authorization: `Bearer ${token}` }, body: data }, withCap(cap));

  it('counts stored bytes in the running total, replacing counts only the delta, deleting frees', async () => {
    const f = await newFamily();
    const pid = rid();
    const base = await total();
    expect((await put(`/api/photos/${pid}`, bytes(10), f.token)).status).toBe(204);
    expect(await total()).toBe(base + 10);
    expect((await put(`/api/photos/${pid}`, bytes(25), f.token)).status).toBe(204);
    expect(await total()).toBe(base + 25);
    expect((await put(`/api/photos/${pid}`, bytes(4), f.token)).status).toBe(204);
    expect(await total()).toBe(base + 4);
    await del(`/api/photos/${pid}`, f.token);
    expect(await total()).toBe(base);
    await del(`/api/photos/${pid}`, f.token); // already gone: nothing to free
    expect(await total()).toBe(base);
  });

  it('refuses a photo that would pass the cap, leaving no object and the total unchanged', async () => {
    const f = await newFamily();
    const base = await total();
    const ok = rid();
    expect((await putCap(`/api/photos/${ok}`, bytes(10), f.token, base + 10)).status).toBe(204);
    const pid = rid();
    const res = await putCap(`/api/photos/${pid}`, bytes(1), f.token, base + 10);
    expect(res.status).toBe(413);
    expect((await res.json()).error).toBe('limit-storage');
    expect(await env.PHOTOS.get(`${f.familyId}/${pid}`)).toBeNull();
    expect(await env.DB.prepare('SELECT 1 FROM photos WHERE family_id = ? AND pid = ?').bind(f.familyId, pid).first()).toBeNull();
    expect(await total()).toBe(base + 10);
    // Existing photos stay readable, and a replacement that does not grow the total still fits.
    expect((await get(`/api/photos/${ok}`, f.token)).status).toBe(200);
    expect((await putCap(`/api/photos/${ok}`, bytes(10, 3), f.token, base + 10)).status).toBe(204);
    // A refused replacement keeps the old object and size.
    expect((await putCap(`/api/photos/${ok}`, bytes(11, 5), f.token, base + 10)).status).toBe(413);
    expect(new Uint8Array(await (await get(`/api/photos/${ok}`, f.token)).arrayBuffer())).toEqual(bytes(10, 3));
    expect((await (await get('/api/photos', f.token)).json()).photos).toMatchObject([{ pid: ok, size: 10 }]);
    expect(await total()).toBe(base + 10);
  });

  it('defaults the cap to 9 GB and ignores a malformed value', async () => {
    const f = await newFamily();
    const base = await total();
    await env.DB.prepare("UPDATE usage SET bytes = 9000000000 - 5 WHERE key = 'photo_bytes'").run();
    try {
      expect((await put(`/api/photos/${rid()}`, bytes(6), f.token)).status).toBe(413);
      expect((await putCap(`/api/photos/${rid()}`, bytes(6), f.token, 'lots')).status).toBe(413);
      expect((await put(`/api/photos/${rid()}`, bytes(5), f.token)).status).toBe(204);
    } finally {
      await env.DB.prepare("UPDATE usage SET bytes = ? WHERE key = 'photo_bytes'").bind(base + 5).run();
    }
  });

  it('lets only one of two concurrent uploads win when together they pass the cap', async () => {
    const f = await newFamily();
    const base = await total();
    const results = await Promise.all([
      putCap(`/api/photos/${rid()}`, bytes(10), f.token, base + 15),
      putCap(`/api/photos/${rid()}`, bytes(10, 2), f.token, base + 15),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([204, 413]);
    expect(await total()).toBe(base + 10);
    const { photos } = await (await get('/api/photos', f.token)).json();
    expect(photos).toHaveLength(1);
    expect((await env.PHOTOS.list({ prefix: `${f.familyId}/` })).objects).toHaveLength(1);
  });

  it('frees the family photos from the total when its last device leaves', async () => {
    const f = await newFamily();
    const base = await total();
    await put(`/api/photos/${rid()}`, bytes(7), f.token);
    await put(`/api/photos/${rid()}`, bytes(8), f.token);
    expect(await total()).toBe(base + 15);
    const res = await del(`/api/devices/${f.deviceId}`, f.token);
    expect(await res.json()).toEqual({ purged: true });
    expect(await total()).toBe(base);
  });

  it('never lets the total go below zero', async () => {
    const f = await newFamily();
    const pid = rid();
    await put(`/api/photos/${pid}`, bytes(10), f.token);
    await env.DB.prepare("UPDATE usage SET bytes = 0 WHERE key = 'photo_bytes'").run();
    await del(`/api/photos/${pid}`, f.token);
    expect(await total()).toBe(0);
  });

  /** An R2 bucket whose put fails after running `before`; everything else is the real bucket. */
  const failingPut = (before = async () => {}) => ({
    PHOTOS: {
      put: async () => {
        await before();
        throw new Error('r2 down');
      },
      get: (...a) => env.PHOTOS.get(...a),
      delete: (...a) => env.PHOTOS.delete(...a),
      list: (...a) => env.PHOTOS.list(...a),
    },
  });
  const putWith = (path, data, token, extra) =>
    call(path, { method: 'PUT', headers: { authorization: `Bearer ${token}` }, body: data }, extra);
  const row = (f, pid) => env.DB.prepare('SELECT size, ready FROM photos WHERE family_id = ? AND pid = ?').bind(f.familyId, pid).first();

  it('gives the reservation back when the R2 write fails (new photo and replacement)', async () => {
    const f = await newFamily();
    const base = await total();
    const fresh = rid();
    expect((await putWith(`/api/photos/${fresh}`, bytes(10), f.token, failingPut())).status).toBe(500);
    expect(await row(f, fresh)).toBeNull();
    expect(await total()).toBe(base);
    const pid = rid();
    await put(`/api/photos/${pid}`, bytes(10), f.token);
    expect((await putWith(`/api/photos/${pid}`, bytes(30), f.token, failingPut())).status).toBe(500);
    expect(await row(f, pid)).toEqual({ size: 10, ready: 1 });
    expect(await total()).toBe(base + 10);
    expect(new Uint8Array(await (await get(`/api/photos/${pid}`, f.token)).arrayBuffer())).toEqual(bytes(10));
  });

  it('does not double-subtract when the photo is deleted while its failed upload is undone', async () => {
    const f = await newFamily();
    const pid = rid();
    await put(`/api/photos/${pid}`, bytes(10), f.token);
    const base = await total();
    const res = await putWith(`/api/photos/${pid}`, bytes(30), f.token, failingPut(() => del(`/api/photos/${pid}`, f.token)));
    expect(res.status).toBe(500);
    expect(await row(f, pid)).toBeNull();
    expect(await total()).toBe(base - 10);
  });

  it('hides an interrupted upload and heals it when the photo is sent again', async () => {
    const f = await newFamily();
    const base = await total();
    const pid = rid();
    // The state left by an isolate that died between the reservation and the R2 write.
    await env.DB.batch([
      env.DB.prepare("UPDATE usage SET bytes = bytes + 10 WHERE key = 'photo_bytes'"),
      env.DB.prepare('INSERT INTO photos (family_id, pid, size, uploaded_at, ready) VALUES (?, ?, 10, ?, 0)').bind(f.familyId, pid, now()),
    ]);
    expect((await (await get('/api/photos', f.token)).json()).photos).toEqual([]);
    expect((await get(`/api/photos/${pid}`, f.token)).status).toBe(404);
    expect((await put(`/api/photos/${pid}`, bytes(10, 4), f.token)).status).toBe(204);
    expect(await total()).toBe(base + 10);
    expect((await (await get('/api/photos', f.token)).json()).photos).toMatchObject([{ pid, size: 10 }]);
    expect(new Uint8Array(await (await get(`/api/photos/${pid}`, f.token)).arrayBuffer())).toEqual(bytes(10, 4));
  });

  it('lets a shrinking replacement through while the total is over the cap', async () => {
    const f = await newFamily();
    const pid = rid();
    await put(`/api/photos/${pid}`, bytes(20), f.token);
    const base = await total();
    expect((await putCap(`/api/photos/${pid}`, bytes(15), f.token, 5)).status).toBe(204);
    expect(await total()).toBe(base - 5);
    expect((await putCap(`/api/photos/${rid()}`, bytes(1), f.token, 5)).status).toBe(413);
  });

  it('leaves the total unchanged when a device that is not the last one is removed', async () => {
    const f = await newFamily();
    await put(`/api/photos/${rid()}`, bytes(9), f.token);
    const base = await total();
    const inv = await (await post('/api/invites', {}, f.token)).json();
    const join = await post('/api/join', { inviteToken: inv.token, deviceId: rid(), deviceNameEnc: 'bmV3' });
    expect(join.status).toBe(200);
    const other = (await env.DB.prepare('SELECT id FROM devices WHERE family_id = ? AND id <> ?').bind(f.familyId, f.deviceId).first()).id;
    const res = await del(`/api/devices/${other}`, f.token);
    expect(await res.json()).toEqual({ purged: false });
    expect(await total()).toBe(base);
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
