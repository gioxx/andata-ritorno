// Bottom sync status line and pull-to-refresh. The line exists only on a device in a family.
import { t } from '../i18n.js'
import { syncStatus } from '../sync/engine.js'
import { esc } from './esc.js'

let active = false
/** Turn the line on (device in a family) or off. */
export const enableSyncLine = (on) => { active = !!on }

/** "5 min ago" style wording; calendar days from yesterday on. */
function ago(iso, now) {
  const min = Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / 60000))
  if (min < 1) return t('sync.agoNow')
  if (min < 60) return t('sync.agoMin', { n: min })
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const days = Math.round((startOfDay(now) - startOfDay(new Date(iso))) / 86400000)
  if (days < 1) return t('sync.agoHour', { n: Math.floor(min / 60) })
  return days === 1 ? t('sync.agoYesterday') : t('sync.agoDays', { n: days })
}

/**
 * @param {import('../sync/engine.js').SyncStatus} status
 * @param {Date} now
 * @param {Map<string,string|null>} deviceNames
 * @returns {string} '' when there is nothing to say yet
 */
export function syncLineText(status, now, deviceNames) {
  if (status.state === 'removed') return t('sync.removed')
  if (status.state === 'syncing') return t('sync.syncing')
  if (status.state === 'offline') return t('sync.offline', { n: status.pending })
  if (!status.lastSyncAt) return ''
  let text = t('sync.updated', { ago: ago(status.lastSyncAt, now) })
  const { count, by } = status.lastChanges
  if (count > 0) text += ` ${t('sync.changes', { n: count, name: deviceNames.get(by) || t('sync.otherDevice') })}`
  if (status.movedOrphans > 0) text += ` · ${t('sync.moved', { n: status.movedOrphans, tab: t('sync.defaultTab') })}`
  return text
}

/** The line as a button (tap = sync now); '' when the device is not in a family. */
export function renderSyncLine() {
  if (!active) return ''
  const text = syncLineText(syncStatus, new Date(), syncStatus.deviceNames) || t('sync.syncing')
  return `<button type="button" class="syncline${syncStatus.state === 'removed' ? ' removed' : ''}" data-act="syncLine">${esc(text)}</button>`
}

const THRESHOLD = 70

/** Pull down from the top of `scrollEl` past 70 px, then release: `onRefresh()`. */
export function initPullToRefresh(scrollEl, onRefresh) {
  let startY = null
  let dy = 0
  scrollEl.addEventListener('touchstart', (e) => {
    startY = scrollEl.scrollTop <= 0 && e.touches.length === 1 ? e.touches[0].clientY : null
    dy = 0
  }, { passive: true })
  scrollEl.addEventListener('touchmove', (e) => {
    if (startY !== null) dy = e.touches[0].clientY - startY
  }, { passive: true })
  scrollEl.addEventListener('touchend', () => {
    const go = startY !== null && dy >= THRESHOLD && scrollEl.scrollTop <= 0
    startY = null
    dy = 0
    if (go) onRefresh()
  }, { passive: true })
  scrollEl.addEventListener('touchcancel', () => { startY = null; dy = 0 }, { passive: true })
}
