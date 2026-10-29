// The "Famiglia" section of the side menu: pure markup from the stored family and the sync status,
// plus the table that turns a server/network error code into a message.
import { t } from '../i18n.js'
import { esc } from './esc.js'
import { ago } from './syncLine.js'
import { usersIcon, refreshIcon, keyIcon, userPlusIcon, plusIcon, lifeBuoyIcon, ticketIcon, mailIcon, smartphoneIcon, logOutIcon } from './icons.js'

/** Every `ApiError.code` the Worker can answer with, plus 'offline' (the request got no answer). */
export const FAMILY_ERROR_CODES = [
  'offline', 'bad-request', 'bad-signature', 'unauthorized', 'not-paid', 'bad-kit', 'bad-code', 'bad-session', 'not-found',
  'code-is-family', 'code-is-slot', 'code-used', 'family-full', 'invite-expired', 'link-expired',
  'limit-photos', 'limit-photo-size', 'limit-storage', 'limit-record-size', 'limit-records', 'too-large', 'rate-limited',
]

/** User-facing message for an ApiError (or any error): unknown codes get a generic line. */
export function familyError(e) {
  const code = typeof e === 'string' ? e : e?.code
  return FAMILY_ERROR_CODES.includes(code) ? t(`family.err.${code}`) : t('family.err.unknown')
}

/** "2 / 4"; the count shows a dash until the family has been read from the server. */
export const devicesText = (devices, limit) => t('family.devicesCount', { n: devices ? devices.length : '–', m: limit ?? '–' })

// Same markup as the menu's own rows (menu.js cannot be imported from here: it imports this file).
const row = (act, icon, label, { sub = '', pill = '', cls = '' } = {}) =>
  `<button type="button" class="menuItem${cls}" data-menu="${act}"><span class="ic">${icon}</span>` +
  `<span class="txt">${label}${sub ? `<small>${sub}</small>` : ''}</span>${pill ? `<span class="badge">${pill}</span>` : ''}</button>`

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
      row('unlock', usersIcon, t('family.unlock'), { sub: t('family.unlockSub'), pill: payments ? t('family.price') : '' }),
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
  return [
    row('sync', refreshIcon, esc(fam?.name ?? t('family.defaultName')), { sub: esc(lastText), pill: t('family.syncNow') }),
    row('devices', smartphoneIcon, t('family.devices'), { pill: devicesText(fam?.devices, fam?.deviceLimit ?? family.deviceLimit) }),
    row('invite', userPlusIcon, t('family.invite')),
    row('slot', plusIcon, t('family.slot'), { pill: payments ? t('family.slotPrice') : '' }),
    row('code', ticketIcon, t('family.haveCode')), // a bought or manual seat code works with payments on or off
    row('kit', keyIcon, t('family.kit')),
    leaveRow(),
  ].join('')
}
