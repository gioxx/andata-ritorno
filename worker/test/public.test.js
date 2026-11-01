import { env } from 'cloudflare:workers';
import { describe, it, expect } from 'vitest';
import worker from '../src/index.js';
import { coarse } from '../src/public.js';

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
    await caches.default.delete(new Request('https://ar.test/api/public/stats?v=2'));
    const res = await worker.fetch(new Request('https://ar.test/api/public/stats', { headers: { origin: 'https://site.test' } }), { ...env, SITE_ORIGIN: 'https://site.test' }, {});
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toMatch(/public, max-age=\d+/);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://site.test');
    const out = await res.json();
    expect(Object.keys(out).sort()).toEqual(['activePhones30d', 'asOf', 'families', 'phones', 'photos', 'syncedRecords']);
    expect(out.families % 10).toBe(0);
    expect(out.families).toBeGreaterThanOrEqual(10);
    expect(out.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
