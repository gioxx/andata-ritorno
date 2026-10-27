import { HttpError } from './http.js';
import { hmacHex } from './auth.js';

const TOLERANCE_SEC = 300;

function equalHex(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Verify a `Stripe-Signature` header (scheme v1, HMAC-SHA256 of `${t}.${rawBody}`) and parse the event.
 * @returns {Promise<object>} the event
 */
export async function verifyWebhook(rawBody, sigHeader, secret, nowSec) {
  const bad = new HttpError(400, 'bad-signature');
  const parts = (sigHeader || '').split(',').map((p) => p.trim().split('='));
  const t = Number(parts.find(([k]) => k === 't')?.[1]);
  const v1 = parts.filter(([k, v]) => k === 'v1' && v).map(([, v]) => v);
  if (!secret || !Number.isInteger(t) || !v1.length || Math.abs(nowSec - t) > TOLERANCE_SEC) throw bad;
  const expected = await hmacHex(secret, `${t}.${rawBody}`);
  if (!v1.some((v) => equalHex(v, expected))) throw bad;
  try {
    return JSON.parse(rawBody);
  } catch {
    throw bad;
  }
}

/**
 * Fetch a Checkout Session with its line items. Unknown ids → 404 `bad-session`; other Stripe
 * failures throw a plain Error (500), so the webhook gets retried.
 * @returns {Promise<{id: string, payment_status: string, customer_details: {email: string|null}, line_items: {price: {id: string}}[]}>}
 */
export async function getCheckoutSession(env, id) {
  if (typeof id !== 'string' || !/^cs_[A-Za-z0-9_]{1,250}$/.test(id)) throw new HttpError(404, 'bad-session');
  const res = await fetch(`https://api.stripe.com/v1/checkout/sessions/${id}?expand[]=line_items`, {
    headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
  });
  if (res.status === 404) throw new HttpError(404, 'bad-session');
  if (!res.ok) throw new Error(`stripe ${res.status}`);
  const s = await res.json();
  return {
    id: s.id,
    payment_status: s.payment_status,
    customer_details: { email: s.customer_details?.email ?? null },
    line_items: (s.line_items?.data ?? []).map((li) => ({ price: { id: li.price?.id ?? null } })),
  };
}
