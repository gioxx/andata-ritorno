import { env } from 'cloudflare:workers';
import { describe, it, expect } from 'vitest';
import worker from '../src/index.js';
import { coarse, isoWeek, validPing } from '../src/public.js';
import { clientIp } from '../src/http.js';

describe('public stats', () => {
  it('rounds down to ten and hides anything below ten', () => {
    expect([0, 1, 9, 10, 19, 237, 1004].map(coarse)).toEqual([null, null, null, 10, 10, 230, 1000]);
  });

  it('shows nothing while there are fewer than ten families', async () => {
    await env.DB.prepare("INSERT INTO photos (family_id, pid, size, uploaded_at, ready) VALUES ('few-1', 'p-1-xxxx', 1, ?, 1)").bind(new Date().toISOString()).run();
    const stmts = [];
    for (let i = 0; i < 30; i++) stmts.push(env.DB.prepare("INSERT INTO records (family_id, rid, seq, data) VALUES ('few-1', ?, ?, 'x')").bind(`few-r-${i}-xxxx`, i + 1));
    await env.DB.batch(stmts);
    const out = await (await worker.fetch(new Request('https://ar.test/api/public/stats?few'), env, {})).json();
    expect(out).toMatchObject({ families: null, phones: null, syncedRecords: null, photos: null });
  });

  it('answers only aggregate, rounded numbers, cacheable, readable by the landing site', async () => {
    const now = new Date().toISOString();
    const stmts = [];
    for (let i = 0; i < 12; i++) {
      stmts.push(env.DB.prepare("INSERT INTO families (id, licence_id, name_enc, recovery_hash, seq, created_at) VALUES (?, 'l', 'x', 'h', 0, ?)").bind(`pub-fam-${i}-xxxx`, now));
    }
    await env.DB.batch(stmts);
    await caches.default.delete(new Request('https://ar.test/api/public/stats?v=3'));
    const res = await worker.fetch(new Request('https://ar.test/api/public/stats', { headers: { origin: 'https://site.test' } }), { ...env, SITE_ORIGIN: 'https://site.test' }, {});
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toMatch(/public, max-age=\d+/);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://site.test');
    const out = await res.json();
    expect(Object.keys(out).sort()).toEqual(['activePhones30d', 'asOf', 'families', 'localPhonesLastWeek', 'phones', 'photos', 'syncedRecords']);
    expect(out.families % 10).toBe(0);
    expect(out.families).toBeGreaterThanOrEqual(10);
    expect(out.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

const ping = (body, ip = '203.0.113.7', e = env) =>
  worker.fetch(new Request('https://ar.test/api/public/ping', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }), e, {});

describe('anonymous weekly ping', () => {
  it('numbers weeks the ISO way', () => {
    expect(isoWeek(new Date('2026-11-02T10:00:00Z'))).toBe('2026-W45');
    expect(isoWeek(new Date('2027-01-01T10:00:00Z'))).toBe('2026-W53');
    expect(isoWeek(new Date('2024-12-30T10:00:00Z'))).toBe('2025-W01');
  });

  it('accepts only the three coarse fields: an extra field (an identifier) is refused', () => {
    expect(validPing({ v: '3.1', items: '6-20', moves: '0' })).toEqual({ v: '3.1', items: '6-20', moves: '0' });
    expect(validPing({ v: '3.1', items: '6-20', moves: '0', id: 'abc' })).toBeNull();
    expect(validPing({ v: '3.1.0', items: '6-20', moves: '0' })).toBeNull();
    expect(validPing({ v: '3.1', items: '7', moves: '0' })).toBeNull();
    expect(validPing({ v: '3.1', items: '1-5' })).toBeNull();
    expect(validPing(['3.1', '1-5', '0'])).toBeNull();
  });

  it('adds one to the counters of the current week and stores nothing else', async () => {
    const week = isoWeek(new Date());
    expect((await ping({ v: '3.1', items: '6-20', moves: '1-5' })).status).toBe(204);
    expect((await ping({ v: '3.1', items: '21+', moves: '1-5' }, '203.0.113.8')).status).toBe(204);
    const { results } = await env.DB.prepare('SELECT * FROM usage_weekly WHERE week = ? ORDER BY metric, bucket').bind(week).all();
    expect(results).toEqual([
      { week, metric: 'items', bucket: '21+', n: 1 },
      { week, metric: 'items', bucket: '6-20', n: 1 },
      { week, metric: 'moves', bucket: '1-5', n: 2 },
      { week, metric: 'phones', bucket: 'all', n: 2 },
      { week, metric: 'version', bucket: '3.1', n: 2 },
    ]);
    // Columns are week, metric, bucket, n: no address, no time, no identifier of any kind.
    expect(Object.keys(results[0]).sort()).toEqual(['bucket', 'metric', 'n', 'week']);
  });

  it('refuses malformed pings', async () => {
    expect((await ping({ v: '3.1', items: '6-20', moves: '0', device: 'x' })).status).toBe(400);
    expect((await ping('not json')).status).toBe(400);
    expect((await ping('x'.repeat(400))).status).toBe(413);
  });

  it('rate-limits per address', async () => {
    const blocked = { RL_STRICT: { limit: async ({ key }) => ({ success: !key.endsWith('198.51.100.1') }) } };
    expect((await ping({ v: '3.1', items: '0', moves: '0' }, '198.51.100.1', { ...env, ...blocked })).status).toBe(429);
    expect((await ping({ v: '3.1', items: '0', moves: '0' }, '198.51.100.2', { ...env, ...blocked })).status).toBe(204);
  });

  it('keys IPv6 addresses on their /64, so rotating inside it does not reset the limit', () => {
    const ip = (a) => clientIp(new Request('https://ar.test/', { headers: { 'cf-connecting-ip': a } }));
    expect(ip('203.0.113.7')).toBe('203.0.113.7');
    expect(ip('2001:db8:0:1:aaaa::1')).toBe('2001:db8:0:1::/64');
    expect(ip('2001:0db8:0000:0001:ffff:1:2:3')).toBe('2001:db8:0:1::/64');
    expect(ip('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(ip('::1')).toBe('0:0:0:0::/64');
  });

  it('drops pings past the weekly cap without writing', async () => {
    const week = isoWeek(new Date());
    const before = await env.DB.prepare("SELECT n FROM usage_weekly WHERE week = ? AND metric = 'phones'").bind(week).first('n');
    expect((await ping({ v: '3.1', items: '0', moves: '0' }, '203.0.113.9', { ...env, PING_WEEKLY_CAP: String(before) })).status).toBe(204);
    expect(await env.DB.prepare("SELECT n FROM usage_weekly WHERE week = ? AND metric = 'phones'").bind(week).first('n')).toBe(before);
  });

  it('stops adding new version buckets after twenty in a week', async () => {
    const week = isoWeek(new Date());
    for (let i = 0; i < 25; i++) await ping({ v: `9.${i}`, items: '0', moves: '0' }, `203.0.113.${100 + i}`);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM usage_weekly WHERE week = ? AND metric = 'version'").bind(week).first('n');
    expect(n).toBe(20);
    await ping({ v: '3.1', items: '0', moves: '0' }); // an existing bucket still counts
    expect(await env.DB.prepare("SELECT n FROM usage_weekly WHERE week = ? AND metric = 'version' AND bucket = '3.1'").bind(week).first('n')).toBeGreaterThan(2);
  });

  it('answers 404, not 500, on malformed percent-encoding', async () => {
    expect((await worker.fetch(new Request('https://ar.test/api/photos/%E0%A4%A'), env, {})).status).toBe(404);
  });

  it('shows last week on the public numbers, rounded and hidden below ten', async () => {
    const last = isoWeek(new Date(Date.now() - 7 * 864e5));
    const read = async () => {
      await caches.default.delete(new Request('https://ar.test/api/public/stats?v=3'));
      return (await (await worker.fetch(new Request('https://ar.test/api/public/stats'), env, {})).json()).localPhonesLastWeek;
    };
    await env.DB.prepare("INSERT INTO usage_weekly (week, metric, bucket, n) VALUES (?, 'phones', 'all', 7)").bind(last).run();
    expect(await read()).toBeNull();
    await env.DB.prepare("UPDATE usage_weekly SET n = 37 WHERE week = ? AND metric = 'phones'").bind(last).run();
    expect(await read()).toBe(30);
  });
});
