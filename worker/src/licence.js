import { HttpError, json, readBody, readJson, strictLimit } from './http.js';
import { hmacHex, randomToken, requireApiDevice, sha256Hex } from './auth.js';
import { codeFromHmac, hashCode, normaliseCode } from './codes.js';
import { createEmbeddedSession, getCheckoutSession, verifyWebhook } from './stripe.js';
import { codeEmail, licenceLinkEmail, sendEmail } from './email.js';
import { notifyOwner, purchaseMessage } from './notify.js';
import { deviceLimit, purgePhotos, purgeStatements, registrationsOpen, requireRegistrationsOpen } from './store.js';
import { ENC, HEX64, ID, isSecret } from './validate.js';

const LINK_TTL_MS = 30 * 60 * 1000;
// Open (unused, unexpired) links per licence beyond which recovery emails stop: protects the
// mailbox and the Resend daily quota from repeated requests.
const MAX_OPEN_LINKS = 3;
// Links per licence in a day, used or not: rotating IPs still cannot flood the buyer's mailbox.
const MAX_DAILY_LINKS = 5;
// Devices a new licence allows; extra slots are bought on top.
const BASE_LIMIT = 3;
const PAID_EVENTS = ['checkout.session.completed', 'checkout.session.async_payment_succeeded'];

/** Validate the fields shared by redeem and restart: the new family and its first device. */
function newFamilyFields(body) {
  const { familyId, deviceId, familyNameEnc, deviceNameEnc, recoveryHash } = body ?? {};
  const ok =
    ID.test(familyId ?? '') && ID.test(deviceId ?? '') && ENC.test(familyNameEnc ?? '') && ENC.test(deviceNameEnc ?? '') && HEX64.test(recoveryHash ?? '');
  if (!ok) throw new HttpError(400, 'bad-request');
  return { familyId, deviceId, familyNameEnc, deviceNameEnc, recoveryHash };
}

/** Run background work after the response when the runtime allows it, inline otherwise (tests). */
async function defer(ctx, promise) {
  if (ctx?.waitUntil) ctx.waitUntil(promise);
  else await promise;
}

const emailHmac = (env, email) => hmacHex(env.EMAIL_HMAC_KEY, email.trim().toLowerCase());

/** Statements creating a family and its first device, each run only if `guard` (an SQL condition) holds. */
function insertFamilyAndDevice(env, f, licenceId, tokenHash, at, guard, guardArgs) {
  return [
    env.DB.prepare(
      `INSERT INTO families (id, licence_id, name_enc, recovery_hash, seq, created_at) SELECT ?, ?, ?, ?, 0, ? WHERE ${guard}`,
    ).bind(f.familyId, licenceId, f.familyNameEnc, f.recoveryHash, at, ...guardArgs),
    env.DB.prepare(
      `INSERT INTO devices (id, family_id, token_hash, name_enc, created_at, last_seen_at) SELECT ?, ?, ?, ?, ?, ? WHERE ${guard}`,
    ).bind(f.deviceId, f.familyId, tokenHash, f.deviceNameEnc, at, at, ...guardArgs),
  ];
}

/** @returns {'family'|'slot'} the kind bought by the session's price; 404 bad-session otherwise. */
function kindOf(env, session) {
  // Unset prices are a deployment mistake, not someone else's session: fail loudly (500).
  if (!env.PRICE_FAMILY || !env.PRICE_SLOT) throw new Error('PRICE_FAMILY / PRICE_SLOT not configured');
  const prices = session.line_items.map((li) => li.price?.id);
  if (env.PRICE_FAMILY && prices.includes(env.PRICE_FAMILY)) return 'family';
  if (env.PRICE_SLOT && prices.includes(env.PRICE_SLOT)) return 'slot';
  throw new HttpError(404, 'bad-session');
}

/**
 * The code for a paid Checkout Session, created on first call. Idempotent on the session id: the
 * code is derived from it (CODE_HMAC_KEY), so the page, the webhook and their retries all get the
 * same code and the UNIQUE stripe_session column keeps a single row.
 * @returns {Promise<{code: string, kind: 'family'|'slot'}>}
 */
export async function issueCodeForSession(env, session) {
  if (!env.CODE_HMAC_KEY) throw new Error('CODE_HMAC_KEY not set');
  const kind = kindOf(env, session);
  const code = await codeFromHmac(env.CODE_HMAC_KEY, session.id);
  const hash = await hashCode(code);
  const email = session.customer_details?.email;
  await env.DB.prepare(
    "INSERT INTO codes (hash, kind, source, stripe_session, email_hmac, created_at) VALUES (?, ?, 'stripe', ?, ?, ?) ON CONFLICT DO NOTHING",
  )
    .bind(hash, kind, session.id, email ? await emailHmac(env, email) : null, new Date().toISOString())
    .run();
  const row = await env.DB.prepare('SELECT hash, kind FROM codes WHERE stripe_session = ?').bind(session.id).first();
  // A mismatch means the stored row was made with another key; the plaintext is then unrecoverable.
  if (!row || row.hash !== hash) throw new Error(`code for ${session.id} does not match the stored hash`);
  return { code, kind: row.kind };
}

/**
 * Replay of a redeem/restart whose response was lost: the licence already powers the family the body
 * names, with the same recovery hash and the body's device in it. That device gets a fresh token
 * (the lost one is replaced), so the client can finish. Anything else → null.
 */
async function replay(env, licenceId, f) {
  if (!licenceId) return null;
  const hit = await env.DB.prepare(
    `SELECT 1 FROM licences l JOIN families f ON f.id = l.family_id JOIN devices d ON d.family_id = f.id
     WHERE l.id = ? AND l.family_id = ? AND f.recovery_hash = ? AND d.id = ?`,
  )
    .bind(licenceId, f.familyId, f.recoveryHash, f.deviceId)
    .first();
  if (!hit) return null;
  const token = randomToken();
  await env.DB.prepare('UPDATE devices SET token_hash = ?, last_seen_at = ? WHERE id = ? AND family_id = ?')
    .bind(await sha256Hex(token), new Date().toISOString(), f.deviceId, f.familyId)
    .run();
  return json({ token, deviceLimit: await deviceLimit(env, licenceId) });
}

async function findCode(env, input) {
  const code = normaliseCode(input);
  if (!code) throw new HttpError(404, 'bad-code');
  const hash = await hashCode(code);
  const row = await env.DB.prepare('SELECT kind, redeemed_at, licence_id FROM codes WHERE hash = ?').bind(hash).first();
  if (!row) throw new HttpError(404, 'bad-code');
  return { hash, ...row };
}

async function redeem(req, env) {
  await strictLimit(env, req);
  const body = await readJson(req);
  const f = newFamilyFields(body);
  const code = await findCode(env, body.code);
  if (code.kind === 'slot') throw new HttpError(409, 'code-is-slot');
  if (code.redeemed_at) return (await replay(env, code.licence_id, f)) ?? codeUsed();
  await requireRegistrationsOpen(env);

  const licenceId = crypto.randomUUID();
  const token = randomToken();
  const at = new Date().toISOString();
  // The fresh licence id marks the request that won the code: concurrent redeems update 0 rows and
  // every following insert is skipped for them.
  const won = 'EXISTS (SELECT 1 FROM codes WHERE hash = ? AND licence_id = ?)';
  const results = await env.DB.batch([
    env.DB.prepare('UPDATE codes SET redeemed_at = ?, licence_id = ? WHERE hash = ? AND redeemed_at IS NULL').bind(at, licenceId, code.hash),
    env.DB.prepare(
      'INSERT INTO licences (id, base_limit, email_hmac, family_id, created_at) SELECT ?, ?, email_hmac, ?, ? FROM codes WHERE hash = ? AND licence_id = ?',
    ).bind(licenceId, BASE_LIMIT, f.familyId, at, code.hash, licenceId),
    ...insertFamilyAndDevice(env, f, licenceId, await sha256Hex(token), at, won, [code.hash, licenceId]),
  ]);
  if (results[0].meta.changes !== 1) {
    // Lost a race: maybe to an identical request (client retry), which then is a replay.
    const row = await env.DB.prepare('SELECT licence_id FROM codes WHERE hash = ?').bind(code.hash).first();
    return (await replay(env, row?.licence_id, f)) ?? codeUsed();
  }
  return json({ token, deviceLimit: await deviceLimit(env, licenceId) });
}

function codeUsed() {
  throw new HttpError(409, 'code-used');
}

async function slot(req, env) {
  await strictLimit(env, req);
  const { familyId } = await requireApiDevice(env, req);
  const body = await readJson(req);
  const code = await findCode(env, body?.code);
  if (code.kind === 'family') throw new HttpError(409, 'code-is-family');
  const { licence_id: licenceId } = await env.DB.prepare('SELECT licence_id FROM families WHERE id = ?').bind(familyId).first();
  // Already added to this very licence: a retry whose first answer was lost, not a reuse.
  if (code.redeemed_at && code.licence_id === licenceId) return json({ deviceLimit: await deviceLimit(env, licenceId) });
  if (code.redeemed_at) throw new HttpError(409, 'code-used');

  const at = new Date().toISOString();
  // changes() is the row count of the previous statement in the batch: a concurrent use of the same
  // code updates no code row and so adds no slot.
  const results = await env.DB.batch([
    env.DB.prepare('UPDATE codes SET redeemed_at = ?, licence_id = ? WHERE hash = ? AND redeemed_at IS NULL').bind(at, licenceId, code.hash),
    env.DB.prepare('UPDATE licences SET extra_slots = extra_slots + 1 WHERE id = ? AND changes() = 1').bind(licenceId),
  ]);
  if (results[0].meta.changes !== 1) throw new HttpError(409, 'code-used');
  return json({ deviceLimit: await deviceLimit(env, licenceId) });
}

/**
 * Start a purchase shown in a modal on the landing site: a Checkout Session for the family unlock
 * or an extra seat. New families are not sold while registrations are closed.
 */
async function checkout(req, env) {
  await strictLimit(env, req);
  const { kind } = (await readJson(req, 1024)) ?? {};
  const price = { family: env.PRICE_FAMILY, slot: env.PRICE_SLOT }[kind];
  if (!['family', 'slot'].includes(kind)) throw new HttpError(400, 'bad-request');
  if (!price) throw new Error('PRICE_FAMILY / PRICE_SLOT not configured');
  if (kind === 'family') await requireRegistrationsOpen(env);
  const session = await createEmbeddedSession(env, price, `${env.APP_ORIGIN}/unlock?session_id={CHECKOUT_SESSION_ID}`);
  return json({ sessionId: session.id, clientSecret: session.clientSecret });
}

const CLOSED_PAGE = `<!doctype html><html lang="it"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>A/R</title>
<body style="font-family:system-ui,sans-serif;max-width:36rem;margin:15vh auto;padding:0 20px;line-height:1.5">
<h1>Attivazioni sospese</h1><p>Le nuove attivazioni sono sospese per un po'. Riprova più tardi: non ti è stato addebitato nulla.</p>
<h1 lang="en">Activations paused</h1><p lang="en">New activations are paused for a while. Try again later: you have not been charged.</p></body></html>`;

/**
 * Every "buy" link (app and landing, with or without JavaScript) goes through here to the Stripe
 * payment link, so closing registrations also stops new family sales.
 */
async function buy(req, env, ctx, { kind }) {
  const link = { family: env.PAY_LINK_FAMILY, slot: env.PAY_LINK_SLOT }[kind];
  if (!['family', 'slot'].includes(kind) || !link) throw new HttpError(404, 'not-found');
  if (kind === 'family' && !(await registrationsOpen(env))) {
    return new Response(CLOSED_PAGE, { status: 503, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'" } });
  }
  return new Response(null, { status: 302, headers: { location: link, 'cache-control': 'no-store' } });
}

async function unlockSession(req, env) {
  await strictLimit(env, req);
  const session = await getCheckoutSession(env, new URL(req.url).searchParams.get('id'));
  if (session.payment_status !== 'paid') throw new HttpError(402, 'not-paid');
  return json(await issueCodeForSession(env, session));
}

async function stripeWebhook(req, env, ctx) {
  const raw = new TextDecoder().decode(await readBody(req, 512 * 1024));
  const event = await verifyWebhook(raw, req.headers.get('stripe-signature'), env.STRIPE_WEBHOOK_SECRET, Math.floor(Date.now() / 1000));
  if (!PAID_EVENTS.includes(event.type)) return json({ received: true });

  // Errors other than "not ours" propagate as 500 so that Stripe retries the delivery.
  let issued;
  let session;
  try {
    session = await getCheckoutSession(env, event.data?.object?.id);
    if (session.payment_status !== 'paid') return json({ received: true });
    issued = await issueCodeForSession(env, session);
  } catch (e) {
    if (!(e instanceof HttpError)) throw e;
    // Every Payment Link on this Stripe account is A/R's: a paid session for an unknown price means
    // the price ids are out of date. Fail (500) so Stripe retries and the error shows, instead of
    // swallowing a purchase.
    if (session?.payment_status === 'paid' && e.code === 'bad-session') throw new Error(`paid session ${session.id} matches no configured price`);
    console.error('webhook: session not handled', event.id, e.code);
    return json({ received: true });
  }
  const to = session.customer_details.email;
  // Sent before answering: if it fails, Stripe retries the delivery and the same code goes out
  // again (once only, thanks to the idempotency key), instead of the buyer never getting it.
  if (to && !(await sendEmail(env, { to, ...codeEmail(issued.code, issued.kind) }, { idempotencyKey: `code-${session.id}` }))) {
    throw new Error('code email not sent');
  }
  // Only from the webhook (the page may issue the code first) and only once the buyer has their
  // code. Not awaited: a slow or failing Telegram never delays or fails the delivery. A rare
  // duplicate is possible if Stripe redelivers an event that was already answered.
  const note = notifyOwner(env, purchaseMessage(issued.kind, session));
  if (ctx?.waitUntil) ctx.waitUntil(note);
  else await note;
  return json({ received: true });
}

async function licenceEmail(req, env, ctx) {
  await strictLimit(env, req);
  const { email } = (await readJson(req)) ?? {};
  if (typeof email !== 'string' || email.length > 320) throw new HttpError(400, 'bad-request');
  // Everything that depends on a match runs after the response, so neither status nor timing tells.
  const work = (async () => {
    const nowIso = new Date().toISOString();
    const { results } = await env.DB.prepare(
      `SELECT l.id FROM licences l WHERE l.email_hmac = ?
       AND (SELECT COUNT(*) FROM licence_links k WHERE k.licence_id = l.id AND k.used_at IS NULL AND k.expires_at > ?) < ?
       AND (SELECT COUNT(*) FROM licence_links k WHERE k.licence_id = l.id AND k.expires_at > ?) < ?
       ORDER BY l.created_at LIMIT 5`,
    )
      // A link created in the last 24 hours expires after now - 24 h + its lifetime.
      .bind(await emailHmac(env, email), nowIso, MAX_OPEN_LINKS, new Date(Date.now() - 24 * 60 * 60 * 1000 + LINK_TTL_MS).toISOString(), MAX_DAILY_LINKS)
      .all();
    if (!results.length) return;
    const expires = new Date(Date.now() + LINK_TTL_MS).toISOString();
    const links = results.map((r) => ({ licenceId: r.id, token: randomToken() }));
    await env.DB.batch(
      await Promise.all(
        links.map(async (l) =>
          env.DB.prepare('INSERT INTO licence_links (hash, licence_id, expires_at) VALUES (?, ?, ?)').bind(await sha256Hex(l.token), l.licenceId, expires),
        ),
      ),
    );
    await sendEmail(env, { to: email.trim(), ...licenceLinkEmail(links.map((l) => `${env.APP_ORIGIN}/licence#${l.token}`)) });
  })().catch((e) => console.error('licence email failed', e));
  await defer(ctx, work);
  return new Response(null, { status: 202, headers: { 'cache-control': 'no-store' } });
}

async function licenceRestart(req, env) {
  await strictLimit(env, req);
  const body = await readJson(req);
  const f = newFamilyFields(body);
  if (!isSecret(body.linkToken)) throw new HttpError(410, 'link-expired');
  const linkHash = await sha256Hex(body.linkToken);
  const at = new Date().toISOString();
  const link = await env.DB.prepare(
    'SELECT k.licence_id, k.used_at, k.expires_at, l.family_id AS old FROM licence_links k JOIN licences l ON l.id = k.licence_id WHERE k.hash = ?',
  )
    .bind(linkHash)
    .first();
  if (!link) throw new HttpError(410, 'link-expired');
  const { licence_id: licenceId, old } = link;
  const expired = () => {
    throw new HttpError(410, 'link-expired');
  };
  if (link.used_at || link.expires_at <= at) return (await replay(env, licenceId, f)) ?? expired();
  await requireRegistrationsOpen(env);
  // The new family id must differ from the old one: it is the marker of the request that used the link.
  if (f.familyId === old) throw new HttpError(400, 'bad-request');

  const token = randomToken();
  const claimed = 'EXISTS (SELECT 1 FROM licences WHERE id = ? AND family_id = ?)';
  const guard = [licenceId, f.familyId];
  const purge = old ? purgeStatements(env.DB, old, claimed, guard) : [];
  let results;
  try {
    results = await env.DB.batch([
      env.DB.prepare('UPDATE licence_links SET used_at = ? WHERE hash = ? AND used_at IS NULL AND expires_at > ?').bind(at, linkHash, at),
      // Only the request that just used the link moves the licence (see slot() for changes()).
      env.DB.prepare('UPDATE licences SET family_id = ? WHERE id = ? AND changes() = 1').bind(f.familyId, licenceId),
      // Every other open link of this licence dies too: none may restart the new family.
      env.DB.prepare(`UPDATE licence_links SET used_at = ? WHERE licence_id = ? AND used_at IS NULL AND ${claimed}`).bind(at, licenceId, ...guard),
      ...purge,
      ...insertFamilyAndDevice(env, f, licenceId, await sha256Hex(token), at, claimed, guard),
    ]);
  } catch (e) {
    // An identical concurrent request won first: its family id now exists, so this batch failed on
    // the primary key and was rolled back as a whole. Treat it as a replay.
    const r = await replay(env, licenceId, f);
    if (r) return r;
    throw e;
  }
  if (results[1].meta.changes !== 1) return (await replay(env, licenceId, f)) ?? expired();
  if (old) await purgePhotos(env, old);
  return json({ token, deviceLimit: await deviceLimit(env, licenceId) });
}

export const licenceRoutes = {
  'POST /api/redeem': redeem,
  'POST /api/slot': slot,
  'POST /api/checkout': checkout,
  'GET /api/buy/:kind': buy,
  'GET /api/unlock/session': unlockSession,
  'POST /api/stripe/webhook': stripeWebhook,
  'POST /api/licence/email': licenceEmail,
  'POST /api/licence/restart': licenceRestart,
};
