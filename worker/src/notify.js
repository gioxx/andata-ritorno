/**
 * Owner notifications through a Telegram bot. Optional: without TELEGRAM_BOT_TOKEN and
 * TELEGRAM_CHAT_ID nothing is sent. Never throws, because a notification must never fail the
 * request that triggered it. Messages carry no personal data (no email, no name): Telegram is a
 * third party.
 * @returns {Promise<boolean>} whether the message was delivered
 */
export async function notifyOwner(env, text) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
    });
    if (!res.ok) throw new Error(`telegram ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return true;
  } catch (e) {
    console.error('telegram notify failed', e);
    return false;
  }
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
