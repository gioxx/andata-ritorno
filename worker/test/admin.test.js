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
    // A foreign page is stopped before anything else.
    expect((await set({ open: false }, { jwt: await token(), origin: 'https://evil.example' })).status).toBe(403);
    expect((await set({ open: false }, { jwt: await token(), origin: null })).status).toBe(404);
    expect((await set({ open: false }, { jwt: await token(), type: 'text/plain' })).status).toBe(404);
    expect((await set({ open: 'no' }, { jwt: await token() })).status).toBe(400);
    expect(await open()).toBe(true);
  });
});

describe('GET /api/admin/usage', () => {
  const usage = async (extra = { RESEND_READ_KEY: 're_test' }, graphql = null, resendUsageApi = null) => {
    await caches.default.delete(new Request('https://resend-usage.internal/v2'));
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url === `https://${DOMAIN}/cdn-cgi/access/certs`) return Response.json({ keys: [jwk] });
      if (url === 'https://api.cloudflare.com/client/v4/graphql' && graphql) return Response.json(graphql);
      if (url === 'https://api.resend.com/usage') {
        return resendUsageApi ? Response.json(resendUsageApi) : Response.json({ message: 'Not found' }, { status: 404 });
      }
      if (url.startsWith('https://api.resend.com/emails')) {
        // Two pages: today's two emails, then one from earlier this month (if not the 1st) and one from last month.
        const now = new Date();
        const today = now.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '.674981+00');
        const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 1)).toISOString();
        const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0)).toISOString();
        if (!url.includes('after=')) return Response.json({ has_more: true, data: [{ id: 'e1', created_at: today, to: ['a@x.test', 'b@x.test'] }, { id: 'e2', created_at: today, to: ['c@x.test'] }] });
        return Response.json({ has_more: true, data: [{ id: 'e3', created_at: monthStart }, { id: 'e4', created_at: lastMonth }] });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    const res = await worker.fetch(new Request('https://ar.test/api/admin/usage', { headers: { 'cf-access-jwt-assertion': await token() } }), { ...env, ...ON, ...extra }, {});
    expect(res.status).toBe(200);
    return res.json();
  };

  it('counts the emails sent and says when Cloudflare analytics are not configured', async () => {
    const today = new Date().toISOString().slice(0, 10);
    await env.DB.prepare('INSERT INTO email_usage (day, n) VALUES (?, 3) ON CONFLICT(day) DO UPDATE SET n = 3').bind(today).run();
    const out = await usage();
    expect(out.emails.today).toBe(3);
    expect(out.emails.month).toBeGreaterThanOrEqual(3);
    expect(out.cloudflare).toEqual({ configured: false });
    const firstDay = new Date().getUTCDate() === 1;
    // List fallback: three recipients today, one earlier this month.
    expect(out.resend).toEqual({ day: firstDay ? 4 : 3, month: 4, source: 'list' });
    expect(out.limits.d1RowsWrittenDay).toBe(100_000);
  });

  it('prefers Resend\'s Usage API (quota units, received mail included)', async () => {
    const out = await usage({ RESEND_READ_KEY: 're_test' }, null, { object: 'usage', emails: { daily: { used: 10, limit: 100 }, monthly: { used: 120, limit: 3000 } } });
    expect(out.resend).toEqual({ day: 10, month: 120, dayLimit: 100, monthLimit: 3000, source: 'usage' });
  });

  it('sums R2 operations into class A and B and passes D1 and Worker days through', async () => {
    const day = new Date().toISOString().slice(0, 10);
    const out = await usage({ RESEND_READ_KEY: 're_test', CF_ANALYTICS_TOKEN: 't', CF_ACCOUNT_ID: 'acc' }, {
      data: { viewer: { accounts: [{
        d1: [{ dimensions: { date: day }, sum: { readQueries: 5, writeQueries: 2, rowsRead: 900, rowsWritten: 40 } }],
        worker: [{ dimensions: { date: day }, sum: { requests: 120, errors: 1, subrequests: 3 } }],
        r2ops: [
          { dimensions: { actionType: 'PutObject' }, sum: { requests: 7 } },
          { dimensions: { actionType: 'GetObject' }, sum: { requests: 30 } },
          { dimensions: { actionType: 'DeleteObject' }, sum: { requests: 5 } },
        ],
        r2size: [{ dimensions: { datetime: new Date().toISOString() }, max: { payloadSize: 1000, metadataSize: 24, objectCount: 9 } }],
      }] } },
    });
    expect(out.cloudflare.d1[0]).toMatchObject({ day, rowsRead: 900, rowsWritten: 40, queries: 7 });
    expect(out.cloudflare.worker[0]).toMatchObject({ requests: 120, errors: 1 });
    expect(out.cloudflare.r2).toEqual({ classAMonth: 7, classBMonth: 30, bytes: 1024, objects: 9 });
  });

  it('reports a GraphQL error instead of failing', async () => {
    const out = await usage({ RESEND_READ_KEY: 're_test', CF_ANALYTICS_TOKEN: 't', CF_ACCOUNT_ID: 'acc' }, { errors: [{ message: 'not authorized' }] });
    expect(out.cloudflare).toEqual({ configured: true, error: 'not authorized' });
  });
});

describe('Telegram on the dashboard', () => {
  const TG = { TELEGRAM_BOT_TOKEN: 'tg-secret-token', TELEGRAM_CHAT_ID: '42' };
  const send = async (extra, telegram, { jwt, origin = 'https://ar.test' } = {}) => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url === `https://${DOMAIN}/cdn-cgi/access/certs`) return Response.json({ keys: [jwk] });
      if (url.startsWith('https://api.telegram.org/')) return telegram(url, init);
      throw new Error(`unexpected fetch ${url}`);
    });
    const headers = { 'content-type': 'application/json', origin, ...(jwt ? { 'cf-access-jwt-assertion': jwt } : {}) };
    return worker.fetch(new Request('https://ar.test/api/admin/telegram/test', { method: 'POST', headers, body: '{}' }), { ...env, ...ON, ...extra }, {});
  };

  it('shows in the stats whether the bot is configured', async () => {
    expect((await (await stats(await token())).json()).telegram).toEqual({ configured: false });
    expect((await (await stats(await token(), { ...ON, ...TG })).json()).telegram).toEqual({ configured: true });
  });

  it('sends a test message to the configured chat', async () => {
    const calls = [];
    const res = await send(TG, (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return Response.json({ ok: true }); }, { jwt: await token() });
    expect(await res.json()).toEqual({ configured: true, sent: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.telegram.org/bottg-secret-token/sendMessage');
    expect(calls[0].body.chat_id).toBe('42');
  });

  it("reports Telegram's reason, and never the token or a stack trace", async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const jwt = await token();
    const refused = await (await send(TG, () => Response.json({ ok: false, description: 'Bad Request: chat not found' }, { status: 400 }), { jwt })).json();
    expect(refused).toEqual({ configured: true, sent: false, error: 'telegram 400: Bad Request: chat not found' });
    const crashed = await (await send(TG, (url) => { throw new TypeError(`network down for ${url}`); }, { jwt })).json();
    expect(crashed).toEqual({ configured: true, sent: false, error: 'unexpected error (see the Worker logs)' });
    expect(logged).toHaveBeenCalled();
    for (const call of logged.mock.calls) expect(call.map(String).join(' ')).not.toContain('tg-secret-token');
  });

  it('says when the bot is not configured', async () => {
    const res = await send({}, () => Response.json({ ok: true }), { jwt: await token() });
    expect(await res.json()).toEqual({ configured: false, sent: false, error: 'not-configured' });
  });

  it('looks absent without a valid token and refuses cross-site requests', async () => {
    const ok = () => Response.json({ ok: true });
    expect((await send(TG, ok)).status).toBe(404);
    expect((await send(TG, ok, { jwt: await token(), origin: 'https://evil.example' })).status).toBe(403);
  });
});

describe('usage errors', () => {
  it('hides unexpected errors behind a generic message', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url === `https://${DOMAIN}/cdn-cgi/access/certs`) return Response.json({ keys: [jwk] });
      throw new Error('internal detail at /some/path.js:12');
    });
    await caches.default.delete(new Request('https://resend-usage.internal/v2'));
    const res = await worker.fetch(new Request('https://ar.test/api/admin/usage', { headers: { 'cf-access-jwt-assertion': await token() } }), { ...env, ...ON, RESEND_READ_KEY: 're', CF_ANALYTICS_TOKEN: 't', CF_ACCOUNT_ID: 'a' }, {});
    const out = await res.json();
    expect(out.resend).toEqual({ error: 'unexpected error (see the Worker logs)' });
    expect(out.cloudflare).toEqual({ configured: true, error: 'unexpected error (see the Worker logs)' });
  });
});
