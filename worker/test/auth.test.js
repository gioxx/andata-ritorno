import { env } from 'cloudflare:workers';
import { describe, it, expect, vi } from 'vitest';
import worker from '../src/index.js';
import { sha256Hex } from '../src/auth.js';

const call = (path, init, extra = {}) =>
  worker.fetch(new Request(`https://ar.test${path}`, init), { ...env, ...extra }, {});

describe('worker base', () => {
  it('serves non-api paths from assets', async () => {
    const ASSETS = { fetch: vi.fn(async () => new Response('app')) };
    const res = await call('/index.html', undefined, { ASSETS });
    expect(ASSETS.fetch).toHaveBeenCalledOnce();
    expect(await res.text()).toBe('app');
  });

  it('answers unknown api paths with 404 not-found', async () => {
    const res = await call('/api/unknown');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not-found' });
  });

  it('works without rate-limit bindings and honours them when present', async () => {
    const RL_API = { limit: async () => ({ success: false }) };
    const res = await call('/api/unknown', undefined, { RL_API });
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: 'rate-limited' });
  });

  it('limits routes a device calls with its token per device only, never per IP', async () => {
    const token = 'tok-rl-device';
    await env.DB.prepare(
      "INSERT INTO devices (id, family_id, token_hash, name_enc, created_at, last_seen_at) VALUES ('d-rl','f-rl',?,'n','2020-01-01T00:00:00.000Z','2020-01-01T00:00:00.000Z')",
    )
      .bind(await sha256Hex(token))
      .run();
    const headers = { authorization: `Bearer ${token}` };
    // The IP bucket is exhausted, the device bucket is not: a first sync with many photos goes on.
    const ipOnly = { limit: async ({ key }) => ({ success: key.startsWith('device:') }) };
    expect((await call('/api/sync?since=0', { headers }, { RL_API: ipOnly })).status).toBe(200);
    expect((await call('/api/photos', { headers }, { RL_API: ipOnly })).status).toBe(200);
    expect((await call('/api/unknown', undefined, { RL_API: ipOnly })).status).toBe(429);
    // The device bucket still applies.
    const deviceOnly = { limit: async ({ key }) => ({ success: !key.startsWith('device:') }) };
    expect((await call('/api/sync?since=0', { headers }, { RL_API: deviceOnly })).status).toBe(429);
    expect((await call('/api/family', { headers }, { RL_API: deviceOnly })).status).toBe(429);
  });
});

describe('requireDevice', async () => {
  const { requireDevice } = await import('../src/auth.js');
  const token = 'tok-test';

  it('rejects missing and unknown tokens with 401 unauthorized', async () => {
    for (const headers of [{}, { authorization: 'Bearer nope' }]) {
      const err = await requireDevice(env, new Request('https://ar.test/x', { headers })).catch((e) => e);
      expect(err.status).toBe(401);
      expect(err.code).toBe('unauthorized');
    }
  });

  it('accepts a valid token and touches last_seen_at', async () => {
    await env.DB.prepare(
      "INSERT INTO devices (id, family_id, token_hash, name_enc, created_at, last_seen_at) VALUES ('d1','f1',?,'n','2020-01-01T00:00:00.000Z','2020-01-01T00:00:00.000Z')",
    )
      .bind(await sha256Hex(token))
      .run();
    const out = await requireDevice(env, new Request('https://ar.test/x', { headers: { authorization: `Bearer ${token}` } }));
    expect(out).toEqual({ deviceId: 'd1', familyId: 'f1' });
    const row = await env.DB.prepare("SELECT last_seen_at FROM devices WHERE id='d1'").first();
    expect(row.last_seen_at > '2020-01-01T00:00:00.000Z').toBe(true);
  });

  it('touches last_seen_at at most every 10 minutes (D1 daily writes)', async () => {
    const recent = new Date(Date.now() - 9 * 60 * 1000).toISOString();
    await env.DB.prepare("INSERT INTO devices (id, family_id, token_hash, name_enc, created_at, last_seen_at) VALUES ('d3','f1',?,'n',?,?)")
      .bind(await sha256Hex('tok-recent'), recent, recent)
      .run();
    await requireDevice(env, new Request('https://ar.test/x', { headers: { authorization: 'Bearer tok-recent' } }));
    const row = await env.DB.prepare("SELECT last_seen_at FROM devices WHERE id='d3'").first();
    expect(row.last_seen_at).toBe(recent);
  });
});

describe('API hardening', () => {
  const call = (path, init = {}, extra = {}) => worker.fetch(new Request(`https://ar.test${path}`, init), { ...env, ...extra }, {});

  it('refuses requests from foreign web pages, with security headers on every answer', async () => {
    const res = await call('/api/invites/info?t=x', { headers: { origin: 'https://evil.example' } });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden-origin' });
    const own = await call('/api/invites/info?t=x', { headers: { origin: 'https://ar.test' } });
    expect(own.status).not.toBe(403);
    for (const r of [res, own]) {
      expect(r.headers.get('x-content-type-options')).toBe('nosniff');
      expect(r.headers.get('cross-origin-resource-policy')).toBe('same-site');
    }
  });

  it('accepts JSON bodies only when declared as JSON', async () => {
    const body = JSON.stringify({ code: 'AR-XXXX-XXXX-XXXX' });
    expect((await call('/api/redeem', { method: 'POST', headers: { 'content-type': 'text/plain' }, body })).status).toBe(415);
    expect((await call('/api/redeem', { method: 'POST', body })).status).toBe(415);
  });

  it('slows down an IP that keeps sending wrong device tokens', async () => {
    let calls = 0;
    const RL_STRICT = { limit: async ({ key }) => ({ success: !(key.startsWith('auth:') && ++calls > 3) }) };
    const statuses = [];
    for (let i = 0; i < 5; i++) {
      statuses.push((await call('/api/family', { headers: { authorization: `Bearer wrong-token-${i}xxxx`, 'cf-connecting-ip': '203.0.113.9' } }, { RL_STRICT })).status);
    }
    expect(statuses).toEqual([401, 401, 401, 429, 429]);
  });

  it('turns a blocked IP away before querying the database', async () => {
    const RL_STRICT = { limit: async ({ key }) => ({ success: !key.startsWith('auth:') }) };
    const ip = '203.0.113.77';
    expect((await call('/api/family', { headers: { authorization: 'Bearer wrong-token-xxxxxxxx', 'cf-connecting-ip': ip } }, { RL_STRICT })).status).toBe(429);
    const prepare = vi.spyOn(env.DB, 'prepare');
    const res = await call('/api/family', { headers: { authorization: 'Bearer another-wrong-token', 'cf-connecting-ip': ip } }, { RL_STRICT });
    expect(res.status).toBe(429);
    expect(prepare).not.toHaveBeenCalled();
    prepare.mockRestore();
  });

  it('keeps a valid phone working when its shared IP is blocked', async () => {
    const RL_STRICT = { limit: async ({ key }) => ({ success: !key.startsWith('auth:') }) };
    const ip = '203.0.113.88';
    const good = 'valid-token-shared-ip-xxxxxxxx';
    await env.DB.prepare("INSERT INTO devices (id, family_id, token_hash, name_enc, created_at, last_seen_at) VALUES ('dev-shared-ip', 'fam-shared-ip', ?, 'x', ?, ?)")
      .bind(await sha256Hex(good), new Date().toISOString(), new Date().toISOString())
      .run();
    const h = (token) => ({ headers: { authorization: `Bearer ${token}`, 'cf-connecting-ip': ip } });
    expect((await call('/api/family', h(good), { RL_STRICT })).status).not.toBe(429);
    expect((await call('/api/family', h('wrong-token-shared-ip-x'), { RL_STRICT })).status).toBe(429);
    expect((await call('/api/family', h(good), { RL_STRICT })).status).not.toBe(429);
  });
});
