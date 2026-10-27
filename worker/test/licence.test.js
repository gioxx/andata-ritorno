import { env } from 'cloudflare:workers';
import { describe, it, expect, vi, afterEach } from 'vitest';
import worker from '../src/index.js';
import { sha256Hex } from '../src/auth.js';
import { newCode, normaliseCode, hashCode } from '../src/codes.js';
import { STRIPE_VERSION, verifyWebhook } from '../src/stripe.js';

const SECRETS = {
  STRIPE_SECRET_KEY: 'sk_test_x',
  STRIPE_WEBHOOK_SECRET: 'whsec_test',
  CODE_HMAC_KEY: 'code-key',
  EMAIL_HMAC_KEY: 'email-key',
  RESEND_API_KEY: 're_test',
  PRICE_FAMILY: 'price_family',
  PRICE_SLOT: 'price_slot',
  APP_ORIGIN: 'https://ar.test',
};

const call = (path, init, extra = {}) =>
  worker.fetch(new Request(`https://ar.test${path}`, init), { ...env, ...SECRETS, ...extra }, {});
const post = (path, body, headers = {}, extra) =>
  call(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }, extra);

const rid = () => crypto.randomUUID();
const now = () => new Date().toISOString();

async function insertCode(kind, { emailHmac = null } = {}) {
  const code = newCode();
  await env.DB.prepare('INSERT INTO codes (hash, kind, source, email_hmac, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(await hashCode(code), kind, 'manual', emailHmac, now())
    .run();
  return code;
}

const redeemBody = (code) => ({
  code,
  familyId: rid(),
  deviceId: rid(),
  familyNameEnc: 'ZmFtaWx5',
  deviceNameEnc: 'ZGV2aWNl',
  recoveryHash: 'a'.repeat(64),
});

async function hmacHex(key, msg) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function signed(event, secret = SECRETS.STRIPE_WEBHOOK_SECRET, t = Math.floor(Date.now() / 1000)) {
  const body = JSON.stringify(event);
  return { body, header: `t=${t},v1=${await hmacHex(secret, `${t}.${body}`)}` };
}

/** Mock Stripe (sessions by id) and Resend; returns the list of sent emails. */
function mockFetch(sessions) {
  const emails = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.hostname === 'api.stripe.com') {
      if (new Headers(init?.headers).get('stripe-version') !== STRIPE_VERSION) return new Response('unpinned', { status: 400 });
      const id = decodeURIComponent(url.pathname.split('/').pop());
      const s = sessions[id];
      if (!s) return Response.json({ error: { type: 'invalid_request_error' } }, { status: 404 });
      return Response.json({
        id,
        object: 'checkout.session',
        payment_status: s.paid ? 'paid' : 'unpaid',
        customer_details: { email: s.email ?? null },
        line_items: { object: 'list', data: [{ price: { id: s.price } }] },
      });
    }
    if (url.hostname === 'api.resend.com') {
      emails.push(JSON.parse(init.body));
      return Response.json({ id: 'email_1' });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  return emails;
}

afterEach(() => vi.restoreAllMocks());

describe('codes', () => {
  it('generates AR-XXXX-XXXX-XXXX Crockford codes', () => {
    for (let i = 0; i < 50; i++) expect(newCode()).toMatch(/^AR-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{4}(-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{4}){2}$/);
  });

  it('normalises case, spaces, dashes and look-alike letters', () => {
    expect(normaliseCode(' ar-0o1i-l2ab-cdef ')).toBe('AR-0011-12AB-CDEF');
    expect(normaliseCode('00011 2ABCDEF')).toBe('AR-0001-12AB-CDEF');
    expect(normaliseCode('AR-0001-12AB-CDEU')).toBeNull();
    expect(normaliseCode('AR-0001')).toBeNull();
    expect(normaliseCode(42)).toBeNull();
  });
});

describe('POST /api/redeem', () => {
  it('redeems a family code once', async () => {
    const code = await insertCode('family');
    const body = redeemBody(code);
    const res = await post('/api/redeem', body);
    expect(res.status).toBe(200);
    const out = await res.json();
    expect(out.deviceLimit).toBe(4);
    expect(typeof out.token).toBe('string');

    const dev = await env.DB.prepare('SELECT family_id FROM devices WHERE token_hash = ?').bind(await sha256Hex(out.token)).first();
    expect(dev.family_id).toBe(body.familyId);
    const fam = await env.DB.prepare('SELECT seq, licence_id, recovery_hash FROM families WHERE id = ?').bind(body.familyId).first();
    expect(fam.seq).toBe(0);
    expect(fam.recovery_hash).toBe(body.recoveryHash);
    const lic = await env.DB.prepare('SELECT family_id FROM licences WHERE id = ?').bind(fam.licence_id).first();
    expect(lic.family_id).toBe(body.familyId);

    const again = await post('/api/redeem', redeemBody(code));
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: 'code-used' });
  });

  it('accepts sloppy input of a valid code', async () => {
    const code = await insertCode('family');
    const sloppy = code.toLowerCase().replace(/-/g, ' ').replace(/0/g, 'o').replace(/1/g, 'l');
    const res = await post('/api/redeem', redeemBody(sloppy));
    expect(res.status).toBe(200);
  });

  it('refuses unknown and slot codes', async () => {
    const bad = await post('/api/redeem', redeemBody(newCode()));
    expect(bad.status).toBe(404);
    expect(await bad.json()).toEqual({ error: 'bad-code' });
    const slot = await post('/api/redeem', redeemBody(await insertCode('slot')));
    expect(slot.status).toBe(409);
    expect(await slot.json()).toEqual({ error: 'code-is-slot' });
  });

  it('lets only one of two concurrent redeems of the same code win', async () => {
    const code = await insertCode('family');
    const bodies = [redeemBody(code), redeemBody(code)];
    const results = await Promise.all(bodies.map((b) => post('/api/redeem', b)));
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const { n } = await env.DB.prepare('SELECT COUNT(*) AS n FROM licences l JOIN codes c ON c.licence_id = l.id WHERE c.hash = ?')
      .bind(await hashCode(code))
      .first();
    expect(n).toBe(1);
    const loser = bodies[results.findIndex((r) => r.status === 409)];
    expect(await env.DB.prepare('SELECT id FROM families WHERE id = ?').bind(loser.familyId).first()).toBeNull();
    expect(await env.DB.prepare('SELECT id FROM devices WHERE id = ?').bind(loser.deviceId).first()).toBeNull();
  });

  it('replays a redeem whose response was lost: same body gets a fresh token', async () => {
    const code = await insertCode('family');
    const body = redeemBody(code);
    const first = await (await post('/api/redeem', body)).json();
    const res = await post('/api/redeem', body);
    expect(res.status).toBe(200);
    const again = await res.json();
    expect(again.deviceLimit).toBe(4);
    expect(again.token).not.toBe(first.token);
    expect(await tokenWorks(again.token)).toBe(true);
    expect(await tokenWorks(first.token)).toBe(false);
    const { n } = await env.DB.prepare('SELECT COUNT(*) AS n FROM devices WHERE family_id = ?').bind(body.familyId).first();
    expect(n).toBe(1);

    for (const wrong of [{ recoveryHash: 'b'.repeat(64) }, { deviceId: rid() }, { familyId: rid() }]) {
      const r = await post('/api/redeem', { ...body, ...wrong });
      expect(r.status).toBe(409);
      expect(await r.json()).toEqual({ error: 'code-used' });
    }
    expect(await tokenWorks(again.token)).toBe(true);
  });

  it('answers two concurrent identical redeems with 200, never 500', async () => {
    const body = redeemBody(await insertCode('family'));
    const results = await Promise.all([post('/api/redeem', body), post('/api/redeem', body)]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    const tokens = await Promise.all(results.map(async (r) => (await r.json()).token));
    // The replay replaced the first token: exactly one of the two is live.
    expect((await Promise.all(tokens.map(tokenWorks))).filter(Boolean)).toHaveLength(1);
  });

  it('returns 429 when the strict rate limit trips', async () => {
    const RL_STRICT = { limit: async () => ({ success: false }) };
    const res = await post('/api/redeem', redeemBody(await insertCode('family')), {}, { RL_STRICT });
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: 'rate-limited' });
  });
});

/** A device token is live if an authed call gets past auth (bad-code instead of 401). */
async function tokenWorks(token) {
  const res = await post('/api/slot', { code: newCode() }, { authorization: `Bearer ${token}` });
  return res.status !== 401;
}

async function newFamily() {
  const res = await post('/api/redeem', redeemBody(await insertCode('family')));
  return (await res.json()).token;
}

describe('POST /api/slot', () => {
  it('needs a device token (through worker.fetch)', async () => {
    const res = await post('/api/slot', { code: newCode() });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
  });

  it('raises the family limit by one, once', async () => {
    const token = await newFamily();
    const auth = { authorization: `Bearer ${token}` };
    const code = await insertCode('slot');
    const res = await post('/api/slot', { code }, auth);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deviceLimit: 5 });
    const again = await post('/api/slot', { code }, auth);
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: 'code-used' });
  });

  it('refuses family codes and counts concurrent uses of one slot code once', async () => {
    const token = await newFamily();
    const auth = { authorization: `Bearer ${token}` };
    const fam = await post('/api/slot', { code: await insertCode('family') }, auth);
    expect(fam.status).toBe(409);
    expect(await fam.json()).toEqual({ error: 'code-is-family' });

    const code = await insertCode('slot');
    const results = await Promise.all([post('/api/slot', { code }, auth), post('/api/slot', { code }, auth)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const third = await post('/api/slot', { code: await insertCode('slot') }, auth);
    expect(await third.json()).toEqual({ deviceLimit: 6 });
  });
});

describe('Stripe', () => {
  const sessionEvent = (id, type = 'checkout.session.completed') => ({ id: `evt_${id}`, type, data: { object: { id, object: 'checkout.session' } } });
  const webhook = async (event, secret) => {
    const { body, header } = await signed(event, secret);
    return call('/api/stripe/webhook', { method: 'POST', headers: { 'stripe-signature': header }, body });
  };

  it('rejects bad and stale signatures', async () => {
    const res = await webhook(sessionEvent('cs_test_bad'), 'whsec_wrong');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'bad-signature' });
    const { body, header } = await signed({ a: 1 }, 'whsec_test', 1000);
    await expect(verifyWebhook(body, header, 'whsec_test', 1000 + 301)).rejects.toMatchObject({ status: 400, code: 'bad-signature' });
    await expect(verifyWebhook(body, header, 'whsec_test', 1000 + 299)).resolves.toEqual({ a: 1 });
    await expect(verifyWebhook(body, '', 'whsec_test', 1000)).rejects.toMatchObject({ code: 'bad-signature' });
  });

  it('issues exactly one code per paid session, whatever the order of page and webhook', async () => {
    const id = 'cs_test_once';
    const emails = mockFetch({ [id]: { paid: true, price: 'price_family', email: 'Payer@Example.com' } });
    const page = async () => {
      const res = await call(`/api/unlock/session?id=${id}`);
      expect(res.status).toBe(200);
      return res.json();
    };
    const first = await page();
    expect(first.kind).toBe('family');
    expect(normaliseCode(first.code)).toBe(first.code);
    expect((await webhook(sessionEvent(id))).status).toBe(200);
    const second = await page();
    expect((await webhook(sessionEvent(id))).status).toBe(200);
    expect(second).toEqual(first);

    const rows = await env.DB.prepare('SELECT hash, kind, source, email_hmac FROM codes WHERE stripe_session = ?').bind(id).all();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0].hash).toBe(await hashCode(first.code));
    expect(rows.results[0].source).toBe('stripe');
    expect(rows.results[0].email_hmac).toBe(await hmacHex(SECRETS.EMAIL_HMAC_KEY, 'payer@example.com'));
    expect(emails).toHaveLength(2);
    expect(emails[0].to).toEqual(['Payer@Example.com']);
    expect(emails[0].from).toBe('A/R <noreply@ar.gioxx.org>');
    expect(emails[0].text).toContain(first.code);
  });

  it('gives the same code when page and webhook race', async () => {
    const id = 'cs_test_race';
    mockFetch({ [id]: { paid: true, price: 'price_family', email: 'race@example.com' } });
    const [a, w, b] = await Promise.all([call(`/api/unlock/session?id=${id}`), webhook(sessionEvent(id)), call(`/api/unlock/session?id=${id}`)]);
    expect(w.status).toBe(200);
    expect(await a.json()).toEqual(await b.json());
    const { n } = await env.DB.prepare('SELECT COUNT(*) AS n FROM codes WHERE stripe_session = ?').bind(id).first();
    expect(n).toBe(1);
  });

  it('webhook first, then page: same code; emailed code redeems', async () => {
    const id = 'cs_test_hook_first';
    const emails = mockFetch({ [id]: { paid: true, price: 'price_family', email: 'hook@example.com' } });
    expect((await webhook(sessionEvent(id))).status).toBe(200);
    expect(emails).toHaveLength(1);
    const { code } = await (await call(`/api/unlock/session?id=${id}`)).json();
    expect(emails[0].text).toContain(code);
    const res = await post('/api/redeem', redeemBody(code));
    expect(res.status).toBe(200);
    const lic = await env.DB.prepare('SELECT l.email_hmac FROM licences l JOIN codes c ON c.licence_id = l.id WHERE c.stripe_session = ?').bind(id).first();
    expect(lic.email_hmac).toBe(await hmacHex(SECRETS.EMAIL_HMAC_KEY, 'hook@example.com'));
  });

  it('refuses unpaid and unknown sessions; price decides the kind', async () => {
    mockFetch({
      cs_test_unpaid: { paid: false, price: 'price_family' },
      cs_test_slot: { paid: true, price: 'price_slot' },
      cs_test_other: { paid: true, price: 'price_other' },
    });
    const unpaid = await call('/api/unlock/session?id=cs_test_unpaid');
    expect(unpaid.status).toBe(402);
    expect(await unpaid.json()).toEqual({ error: 'not-paid' });
    expect((await call('/api/unlock/session?id=cs_test_missing')).status).toBe(404);
    expect((await call('/api/unlock/session?id=../../v1/charges')).status).toBe(404);
    const other = await call('/api/unlock/session?id=cs_test_other');
    expect(other.status).toBe(404);
    expect(await other.json()).toEqual({ error: 'bad-session' });
    const slot = await call('/api/unlock/session?id=cs_test_slot');
    expect((await slot.json()).kind).toBe('slot');
    expect((await post('/api/redeem', redeemBody((await (await call('/api/unlock/session?id=cs_test_slot')).json()).code))).status).toBe(409);
  });

  it('webhook ignores unpaid sessions and other events', async () => {
    const emails = mockFetch({ cs_test_hook_unpaid: { paid: false, price: 'price_family', email: 'x@example.com' } });
    expect((await webhook(sessionEvent('cs_test_hook_unpaid'))).status).toBe(200);
    expect((await webhook({ id: 'evt_other', type: 'charge.refunded', data: { object: {} } })).status).toBe(200);
    expect(emails).toHaveLength(0);
    const { n } = await env.DB.prepare("SELECT COUNT(*) AS n FROM codes WHERE stripe_session = 'cs_test_hook_unpaid'").first();
    expect(n).toBe(0);
  });

  it('a failing email send does not fail the webhook', async () => {
    const id = 'cs_test_mail_down';
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(typeof input === 'string' ? input : input.url);
      if (url.hostname === 'api.resend.com') return new Response('down', { status: 500 });
      return Response.json({ id, payment_status: 'paid', customer_details: { email: 'a@example.com' }, line_items: { data: [{ price: { id: 'price_family' } }] } });
    });
    expect((await webhook(sessionEvent(id))).status).toBe(200);
    const { n } = await env.DB.prepare('SELECT COUNT(*) AS n FROM codes WHERE stripe_session = ?').bind(id).first();
    expect(n).toBe(1);
  });
});

describe('licence recovery', () => {
  async function paidFamily(email) {
    const code = await insertCode('family', { emailHmac: await hmacHex(SECRETS.EMAIL_HMAC_KEY, email) });
    const body = redeemBody(code);
    const { token } = await (await post('/api/redeem', body)).json();
    return { familyId: body.familyId, token };
  }

  it('answers 202 and sends nothing for an unknown address', async () => {
    const emails = mockFetch({});
    const res = await post('/api/licence/email', { email: 'nobody@example.com' });
    expect(res.status).toBe(202);
    expect(emails).toHaveLength(0);
  });

  it('emails one link for a known address and restarts the family on the same licence', async () => {
    const old = await paidFamily('owner@example.com');
    const auth = { authorization: `Bearer ${old.token}` };
    expect((await post('/api/slot', { code: await insertCode('slot') }, auth)).status).toBe(200);
    // Old family content that the restart must purge.
    await env.DB.batch([
      env.DB.prepare("INSERT INTO records (family_id, rid, seq, data) VALUES (?, 'r1', 1, 'x')").bind(old.familyId),
      env.DB.prepare("INSERT INTO photos (family_id, pid, size, uploaded_at) VALUES (?, 'p1', 3, ?)").bind(old.familyId, now()),
      env.DB.prepare("INSERT INTO invites (hash, family_id, expires_at) VALUES (?, ?, '2099-01-01')").bind(rid(), old.familyId),
    ]);
    await env.PHOTOS.put(`${old.familyId}/p1`, 'abc');

    const emails = mockFetch({});
    const res = await post('/api/licence/email', { email: '  OWNER@example.com ' });
    expect(res.status).toBe(202);
    expect(emails).toHaveLength(1);
    expect(emails[0].to).toEqual(['  OWNER@example.com '.trim()]);
    const link = /https:\/\/ar\.test\/licence#([A-Za-z0-9_-]{43})/.exec(emails[0].text);
    expect(link).not.toBeNull();

    const fresh = { ...redeemBody(undefined), linkToken: link[1] };
    delete fresh.code;
    const restart = await post('/api/licence/restart', fresh);
    expect(restart.status).toBe(200);
    const out = await restart.json();
    expect(out.deviceLimit).toBe(5);

    // Old device revoked, old family purged, licence kept with its slot.
    expect((await post('/api/slot', { code: newCode() }, auth)).status).toBe(401);
    for (const table of ['records', 'photos', 'invites', 'devices']) {
      const { n } = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE family_id = ?`).bind(old.familyId).first();
      expect(n, table).toBe(0);
    }
    expect(await env.DB.prepare('SELECT id FROM families WHERE id = ?').bind(old.familyId).first()).toBeNull();
    expect(await env.PHOTOS.get(`${old.familyId}/p1`)).toBeNull();
    const lic = await env.DB.prepare('SELECT l.family_id, l.extra_slots FROM licences l JOIN families f ON f.licence_id = l.id WHERE f.id = ?')
      .bind(fresh.familyId)
      .first();
    expect(lic).toEqual({ family_id: fresh.familyId, extra_slots: 1 });
    const dev = await env.DB.prepare('SELECT family_id FROM devices WHERE token_hash = ?').bind(await sha256Hex(out.token)).first();
    expect(dev.family_id).toBe(fresh.familyId);

    // The link is single-use.
    const reuse = await post('/api/licence/restart', { ...fresh, familyId: rid(), deviceId: rid() });
    expect(reuse.status).toBe(410);
    expect(await reuse.json()).toEqual({ error: 'link-expired' });
  });

  it('refuses expired and unknown links', async () => {
    const { familyId } = await paidFamily('late@example.com');
    const { licence_id } = await env.DB.prepare('SELECT licence_id FROM families WHERE id = ?').bind(familyId).first();
    const token = 'expired-token-expired-token-expired-token-x';
    await env.DB.prepare("INSERT INTO licence_links (hash, licence_id, expires_at) VALUES (?, ?, '2000-01-01T00:00:00.000Z')")
      .bind(await sha256Hex(token), licence_id)
      .run();
    for (const linkToken of [token, 'unknown-token']) {
      const body = { ...redeemBody(undefined), linkToken };
      delete body.code;
      const res = await post('/api/licence/restart', body);
      expect(res.status).toBe(410);
    }
    expect(await env.DB.prepare('SELECT id FROM families WHERE id = ?').bind(familyId).first()).not.toBeNull();
  });

  it('lets only one of two concurrent restarts with the same link win', async () => {
    const { familyId: oldFamily } = await paidFamily('twice@example.com');
    const emails = mockFetch({});
    await post('/api/licence/email', { email: 'twice@example.com' });
    const linkToken = /licence#([A-Za-z0-9_-]{43})/.exec(emails[0].text)[1];
    const bodies = [0, 1].map(() => {
      const b = { ...redeemBody(undefined), linkToken };
      delete b.code;
      return b;
    });
    const results = await Promise.all(bodies.map((b) => post('/api/licence/restart', b)));
    expect(results.map((r) => r.status).sort()).toEqual([200, 410]);
    const winner = bodies[results.findIndex((r) => r.status === 200)];
    const loser = bodies[results.findIndex((r) => r.status === 410)];
    const { licence_id } = await env.DB.prepare('SELECT licence_id FROM families WHERE id = ?').bind(winner.familyId).first();
    const lic = await env.DB.prepare('SELECT family_id FROM licences WHERE id = ?').bind(licence_id).first();
    expect(lic.family_id).toBe(winner.familyId);
    expect(await env.DB.prepare('SELECT id FROM families WHERE id = ?').bind(loser.familyId).first()).toBeNull();
    expect(await env.DB.prepare('SELECT id FROM families WHERE id = ?').bind(oldFamily).first()).toBeNull();
  });

  async function linkFor(email, emails) {
    await post('/api/licence/email', { email });
    return /licence#([A-Za-z0-9_-]{43})/.exec(emails.at(-1).text)[1];
  }
  const restartBody = (linkToken) => {
    const b = { ...redeemBody(undefined), linkToken };
    delete b.code;
    return b;
  };

  it('replays a restart whose response was lost; wrong body stays 410', async () => {
    await paidFamily('replay@example.com');
    const emails = mockFetch({});
    const body = restartBody(await linkFor('replay@example.com', emails));
    const first = await (await post('/api/licence/restart', body)).json();
    const res = await post('/api/licence/restart', body);
    expect(res.status).toBe(200);
    const again = await res.json();
    expect(await tokenWorks(again.token)).toBe(true);
    expect(await tokenWorks(first.token)).toBe(false);
    for (const wrong of [{ recoveryHash: 'b'.repeat(64) }, { deviceId: rid() }, { familyId: rid() }]) {
      const r = await post('/api/licence/restart', { ...body, ...wrong });
      expect(r.status).toBe(410);
      expect(await r.json()).toEqual({ error: 'link-expired' });
    }
    expect(await env.DB.prepare('SELECT id FROM families WHERE id = ?').bind(body.familyId).first()).not.toBeNull();
  });

  it('answers two concurrent identical restarts with 200, never 500', async () => {
    await paidFamily('same@example.com');
    const emails = mockFetch({});
    const body = restartBody(await linkFor('same@example.com', emails));
    const results = await Promise.all([post('/api/licence/restart', body), post('/api/licence/restart', body)]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    const tokens = await Promise.all(results.map(async (r) => (await r.json()).token));
    expect((await Promise.all(tokens.map(tokenWorks))).filter(Boolean)).toHaveLength(1);
  });

  it('a restart voids the other open links of the licence', async () => {
    await paidFamily('links@example.com');
    const emails = mockFetch({});
    const a = await linkFor('links@example.com', emails);
    const b = await linkFor('links@example.com', emails);
    expect((await post('/api/licence/restart', restartBody(a))).status).toBe(200);
    const res = await post('/api/licence/restart', restartBody(b));
    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({ error: 'link-expired' });
  });

  it('stops emailing once a licence has 3 open links', async () => {
    await paidFamily('flood@example.com');
    const emails = mockFetch({});
    for (let i = 0; i < 5; i++) expect((await post('/api/licence/email', { email: 'flood@example.com' })).status).toBe(202);
    expect(emails).toHaveLength(3);
  });
});
