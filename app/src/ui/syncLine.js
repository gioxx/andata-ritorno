// Sync status bar under the tabs (status line, progress) and pull-to-refresh. It exists only on
// a device in a family.
import { t } from '../i18n.js'
import { syncStatus } from '../sync/engine.js'
import { esc } from './esc.js'
import { familyError } from './familyMenu.js'
import { store } from '../store.js'

let active = false
/** Turn the line on (device in a family) or off. */
export const enableSyncLine = (on) => {
  active = !!on
  document.documentElement.classList.toggle('in-family', active) // gates the family-only CSS
  if (active) liveRegion() // in place before its first message, or that one would not be read
}

/** "5 min ago" style wording; calendar days from yesterday on. */
export function ago(iso, now) {
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
  // Changes still waiting, appended to the offline and error wording.
  const waiting = status.pending > 0 ? ` · ${t('sync.pending', { n: status.pending })}` : ''
  if (status.state === 'offline') return t('sync.offline') + waiting
  if (status.state === 'error') return familyError(status.errorCode ?? 'internal') + waiting
  if (!status.lastSyncAt) return ''
  let text = t('sync.updated', { ago: ago(status.lastSyncAt, now) })
  const { count, by } = status.lastChanges
  if (count > 0) text += ` ${t('sync.changes', { n: count, name: deviceNames.get(by) || t('sync.otherDevice') })}`
  if (status.movedOrphans > 0) text += ` · ${t('sync.moved', { n: status.movedOrphans, tab: status.movedOrphansTab ?? t('sync.defaultTab') })}`
  return text
}

/**
 * What the bar shows: the run's phase, else the background photo counter; null = no bar.
 * @param {Pick<import('../sync/engine.js').SyncStatus, 'progress'|'photoDownloads'>} status
 * @returns {{phase:string, done:number, total:number|null}|null}
 */
export function syncProgress(status) {
  const p = status.progress
  if (p) return { phase: p.phase, done: p.done, total: p.total ?? null }
  const d = status.photoDownloads
  if (d && d.total > 0) return { phase: 'download-photos', done: d.done, total: d.total }
  return null
}

const PHASE_TEXT = {
  'upload-photos': 'sync.progress.uploadPhotos', push: 'sync.progress.push', pull: 'sync.progress.pull', 'download-photos': 'sync.progress.photos',
}
const determinate = (p) => p.total !== null && p.total > 0 && !!PHASE_TEXT[p.phase]

/** "Invio foto 2 di 5"; a phase with no total yet gets its name only. */
export function progressText(p) {
  if (!determinate(p)) return t(p.phase === 'pull' ? 'sync.progress.pullWaiting' : 'sync.syncing')
  return t(PHASE_TEXT[p.phase], { n: Math.min(p.done, p.total), m: p.total })
}

const busy = () => syncStatus.state === 'syncing' || !!syncProgress(syncStatus)

// The phase text on screen is hidden from screen readers (it changes on every tick): a single live
// region outside the re-rendered screen says it once per phase.
let live = null
let spokenPhase = null
function liveRegion() {
  if (!live?.isConnected) {
    live = document.createElement('p')
    live.className = 'sr'
    live.setAttribute('aria-live', 'polite')
    document.body.append(live)
  }
  return live
}
function announce(p) {
  const phase = p?.phase ?? null
  if (phase === spokenPhase) return
  spokenPhase = phase
  if (phase) liveRegion().textContent = progressText(p)
}

/** Progress markup; widths are set afterwards through CSSOM (the CSP allows no inline styles). */
function progressHtml(p) {
  const text = esc(progressText(p))
  const values = determinate(p) ? ` aria-valuemin="0" aria-valuemax="${p.total}" aria-valuenow="${Math.min(p.done, p.total)}"` : ''
  return `<div class="syncprog"><div class="track${determinate(p) ? '' : ' indeterminate'}" role="progressbar" aria-label="${text}"${values}><i></i></div>` +
    `<span class="syncphase" aria-hidden="true">${text}</span></div>`
}

/** The bar: the line as a button (tap = sync now), then the progress while there is any; '' outside a family. */
export function renderSyncLine() {
  if (!active) return ''
  const text = syncLineText(syncStatus, new Date(), syncStatus.deviceNames) || t('sync.syncing')
  const p = syncProgress(syncStatus)
  return `<div class="syncbar" aria-busy="${busy()}"><button type="button" class="syncline${syncStatus.state === 'removed' ? ' removed' : ''}" data-act="syncLine">${esc(text)}</button>${p ? progressHtml(p) : ''}</div>`
}

/** After the bar is in the DOM: the fill width, and the phase said aloud when it changed. */
export function paintSyncLine(root) {
  const p = active ? syncProgress(syncStatus) : null
  const fill = root.querySelector('.syncbar .track:not(.indeterminate) > i')
  if (fill && p) fill.style.width = `${Math.round((100 * Math.min(p.done, p.total)) / p.total)}%`
  announce(p)
}

/** A progress tick: update the bar in place (the line's button, and its focus, stay). */
export function patchSyncLine(root) {
  const bar = root.querySelector('.syncbar')
  if (!bar) return announce(null)
  const p = syncProgress(syncStatus)
  bar.setAttribute('aria-busy', String(busy()))
  const old = bar.querySelector('.syncprog')
  const track = old?.querySelector('.track')
  if (!p) old?.remove()
  else if (track && track.classList.contains('indeterminate') === !determinate(p)) {
    const text = progressText(p)
    track.setAttribute('aria-label', text)
    if (determinate(p)) {
      track.setAttribute('aria-valuemax', String(p.total))
      track.setAttribute('aria-valuenow', String(Math.min(p.done, p.total)))
    }
    old.querySelector('.syncphase').textContent = text
  } else {
    old?.remove()
    bar.insertAdjacentHTML('beforeend', progressHtml(p))
  }
  paintSyncLine(root)
}

const PATCH_MS = 100 // at most 10 repaints a second, however fast the counters move
let patchTimer = null
let lastPatch = 0
/** Throttled `patchSyncLine`: the latest status is painted, at most every 100 ms. */
export function scheduleSyncLinePatch(root) {
  if (patchTimer) return
  patchTimer = setTimeout(() => {
    patchTimer = null
    lastPatch = Date.now()
    patchSyncLine(root)
  }, Math.max(0, lastPatch + PATCH_MS - Date.now()))
}

const THRESHOLD = 70

/** Touches that belong to another gesture: viewer swipes, dialogs and the menu, selection mode. */
const ignored = (e) =>
  store.selected.size > 0 || !!e.target?.closest?.('#viewer, dialog') ||
  !!document.querySelector('dialog[open], #viewer:not([hidden])')

/** Pull down from the top of `scrollEl` past 70 px (mostly vertical), then release: `onRefresh()`. */
export function initPullToRefresh(scrollEl, onRefresh) {
  let start = null
  let dx = 0
  let dy = 0
  const reset = () => { start = null; dx = 0; dy = 0 }
  scrollEl.addEventListener('touchstart', (e) => {
    reset()
    if (scrollEl.scrollTop <= 0 && e.touches.length === 1 && !ignored(e)) start = { x: e.touches[0].clientX ?? 0, y: e.touches[0].clientY }
  }, { passive: true })
  scrollEl.addEventListener('touchmove', (e) => {
    if (!start) return
    if (e.touches.length !== 1 || ignored(e)) return reset()
    dx = (e.touches[0].clientX ?? 0) - start.x
    dy = e.touches[0].clientY - start.y
  }, { passive: true })
  scrollEl.addEventListener('touchend', () => {
    const go = !!start && dy >= THRESHOLD && Math.abs(dy) > Math.abs(dx) && scrollEl.scrollTop <= 0
    reset()
    if (go) onRefresh()
  }, { passive: true })
  scrollEl.addEventListener('touchcancel', reset, { passive: true })
}
