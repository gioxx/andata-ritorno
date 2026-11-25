// The launch offer of yearly licences: a Stripe promotion code that takes the first year from
// 6,99 € to 4,99 €. The code itself lives on Stripe (coupon + promotion code, same end date); this
// only decides whether the app mentions it. After `until` the hint disappears by itself.
export const PROMO = Object.freeze({ code: 'CALZINO', price: { it: '4,99 €', en: '€4.99' }, until: '2026-12-08T00:00:00+01:00' })

/** @param {Date} [now] */
export const promoActive = (now = new Date()) => now < new Date(PROMO.until)
