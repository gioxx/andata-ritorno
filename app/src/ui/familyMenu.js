// The "Famiglia" section of the side menu: pure markup from the stored family and the sync status,
// plus the table that turns a server/network error code into a message.
import { t, getLang } from '../i18n.js'
import { PROMO, promoActive } from '../promo.js'
import { esc } from './esc.js'
import { ago } from './syncLine.js'
import { usersIcon, refreshIcon, keyIcon, userPlusIcon, lifeBuoyIcon, ticketIcon, mailIcon, smartphoneIcon, logOutIcon, calendarIcon } from './icons.js'

/** Every `ApiError.code` the Worker can answer with, plus 'offline' (the request got no answer). */
export const FAMILY_ERROR_CODES = [
  'offline', 'bad-request', 'bad-signature', 'unauthorized', 'not-paid', 'bad-kit', 'bad-code', 'bad-session', 'not-found',
  'code-is-family', 'code-is-slot', 'code-used', 'family-full', 'invite-expired', 'link-expired',
  'limit-photos', 'limit-photo-size', 'limit-storage', 'limit-record-size', 'limit-records', 'limit-daily', 'too-large', 'rate-limited',
  'already-in-family', 'registrations-closed', 'unsupported-media-type', 'forbidden-origin', 'too-many-invites',
  'licence-expired', 'licence-lifetime', 'retry',
]

// A yearly licence ending within this many days gets the renewal row highlighted.
export const RENEW_SOON_DAYS = 30

/** "25 novembre 2027" / "25 November 2027". */
export const dateText = (iso) => new Date(iso).toLocaleDateString(getLang() === 'it' ? 'it-IT' : 'en-GB', { day: 'numeric', month: 'long', year: 'numeric' })

/**
 * Where a yearly licence stands: 'expired', 'soon' (within RENEW_SOON_DAYS) or 'ok'; null for a
 * lifetime licence or one not read from the server yet.
 * @param {string|null|undefined} expiresAt @param {Date} [now]
 */
export function licenceState(expiresAt, now = new Date()) {
  if (typeof expiresAt !== 'string') return null
  const left = Date.parse(expiresAt) - now.getTime()
  if (left <= 0) return 'expired'
  return left < RENEW_SOON_DAYS * 864e5 ? 'soon' : 'ok'
}

/** The launch offer line, or '' once it is over. */
export const promoText = (now = new Date()) =>
  promoActive(now) ? t('family.promo', { code: PROMO.code, price: PROMO.price[getLang() === 'it' ? 'it' : 'en'], until: dateText(new Date(new Date(PROMO.until) - 1).toISOString()) }) : ''

/** User-facing message for an ApiError (or any error): unknown codes get a generic line. */
export function familyError(e) {
  const code = typeof e === 'string' ? e : e?.code
  return FAMILY_ERROR_CODES.includes(code) ? t(`family.err.${code}`) : t('family.err.unknown')
}

/** "2 / 4"; the count shows a dash until the family has been read from the server. Number(): the
 * limit comes from the server and ends up in innerHTML. */
export const devicesText = (devices, limit) => t('family.devicesCount', { n: devices ? devices.length : '–', m: limit == null ? '–' : Number(limit) })

// Same markup as the menu's own rows (menu.js cannot be imported from here: it imports this file).
// clip: one line with an ellipsis (a family name can be as long as the user wants).
const row = (act, icon, label, { sub = '', pill = '', cls = '', clip = false } = {}) =>
  `<button type="button" class="menuItem${cls}" data-menu="${act}"><span class="ic">${icon}</span>` +
  `<span class="txt">${clip ? `<span class="clip">${label}</span>` : label}${sub ? `<small>${sub}</small>` : ''}</span>${pill ? `<span class="badge">${pill}</span>` : ''}</button>`

const leaveRow = () => row('leave', logOutIcon, t('family.leave'), { cls: ' danger' })

/**
 * @param {{ family: import('../sync/family.js').FamilyMeta|null, info?: import('../sync/engine.js').SyncStatus|null,
 *   payments: boolean, now?: Date }} s
 * @returns {string} rows only (the heading is the menu's)
 */
export function familyMenuHtml({ family, info = null, payments, now = new Date() }) {
  // A redeem still waiting for its answer is not a family yet: the code row stays available.
  if (!family || family.pending) {
    return [
      row('unlock', usersIcon, t('family.unlock'), { sub: payments && promoText(now) ? `${t('family.unlockSub')} · ${promoText(now)}` : t('family.unlockSub'), pill: payments ? t('family.price') : '' }),
      row('code', ticketIcon, t('family.haveCode')),
      row('invite-have', userPlusIcon, t('family.haveInvite')),
      row('restore', lifeBuoyIcon, t('family.restore')),
      row('licence', mailIcon, t('family.licence')),
    ].join('')
  }
  if (family.removed || info?.state === 'removed') {
    return `<p class="info">${t('family.removedText')}</p>${leaveRow()}`
  }
  const fam = info?.family ?? null
  const last = info?.lastSyncAt ?? family.lastSyncAt
  const lastText = t('family.lastSync', { ago: last ? ago(last, now) : t('family.neverSynced') })
  // The server's answer when there is one, else what this phone stored at its last sync.
  const expiresAt = fam ? fam.expiresAt : family.expiresAt
  const state = licenceState(expiresAt, now)
  const renew = state
    ? row('renew', calendarIcon, t('family.renew'), {
      sub: t(state === 'expired' ? 'family.renew.expired' : 'family.renew.until', { date: dateText(expiresAt) }),
      pill: state === 'ok' ? '' : t(state === 'expired' ? 'family.renew.expiredPill' : 'family.renew.soonPill'),
      cls: state === 'ok' ? '' : ' attention',
    })
    : ''
  return [
    row('sync', refreshIcon, esc(fam?.name ?? t('family.defaultName')), { sub: esc(lastText), pill: t('family.syncNow'), clip: true }),
    // Inviting a phone and adding a seat live in the devices dialog, under the list they extend.
    row('devices', smartphoneIcon, t('family.devices'), { pill: devicesText(fam?.devices, fam?.deviceLimit ?? family.deviceLimit) }),
    renew,
    row('kit', keyIcon, t('family.kit')),
    leaveRow(),
  ].join('')
}

/**
 * Actions under the devices list: invite while a seat is free, and always a way to add one
 * (buy it with payments on, or type an extra-seat code).
 * @param {{devices: unknown[], deviceLimit: number}} fam @param {boolean} payments
 * @returns {string}
 */
export function devicesActions(fam, payments) {
  const free = fam.devices.length < Number(fam.deviceLimit)
  return `<div class="famDevActions">${free ? `<button type="button" data-invite>${t('family.invite')}</button>` : `<p class="plain">${t('family.devices.full')}</p>`}` +
    `<button type="button" class="${free ? 'cancel' : ''}" data-slot>${t('family.slot')}${payments ? ` · ${t('family.slotPrice')}` : ''}</button></div>`
}
