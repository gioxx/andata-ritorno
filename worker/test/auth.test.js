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
