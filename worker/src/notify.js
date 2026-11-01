import { UpstreamError, publicError } from './http.js';

/**
 * Owner notifications through a Telegram bot. Optional: without TELEGRAM_BOT_TOKEN and
 * TELEGRAM_CHAT_ID nothing is sent. Never throws, because a notification must never fail the
 * request that triggered it. Messages carry no personal data (no email, no name): Telegram is a
 * third party.
 * @returns {Promise<{ok: boolean, error?: string}>} error: Telegram's reason, for the dashboard test
 */
export async function notifyOwner(env, text) {
  if (!telegramConfigured(env)) return { ok: false, error: 'not-configured' };
  try {
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new UpstreamError(`telegram ${res.status}: ${String(body?.description ?? '').slice(0, 200)}`);
    }
    return { ok: true };
  } catch (e) {
    // The token is part of the URL: a non-Upstream error is never shown, only logged without it.
    return { ok: false, error: publicError(e instanceof UpstreamError ? e : new Error(String(e?.message ?? e).split(env.TELEGRAM_BOT_TOKEN).join('***')), 'telegram notify failed') };
  }
}

/** Both secrets are set (whether they are right only a test message can tell). */
export function telegramConfigured(env) {
  return Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID);
}

/** Formats an amount in minor units ("1500", "eur") as "15,00 EUR". */
function money(amount, currency) {
  if (typeof amount !== 'number' || !currency) return null;
  return `${(amount / 100).toFixed(2).replace('.', ',')} ${currency.toUpperCase()}`;
}

/** @param {'family'|'slot'} kind @param {object} session a paid Stripe Checkout Session */
export function purchaseMessage(kind, session) {
  const what = kind === 'slot' ? 'posto in più' : 'nuova famiglia';
  const amount = money(session.amount_total, session.currency);
  const test = session.livemode === false ? ' [test]' : '';
  return `A/R: acquisto, ${what}${amount ? ` (${amount})` : ''}${test}`;
}
