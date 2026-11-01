// Pure helpers behind the menu and the import flow (no DOM, unit-tested).
import { t, getLang } from '../i18n.js'
import { esc } from './esc.js'

/** "N capi · ultimo backup: <date>|mai" */
/** @param {boolean} [synced] in an active family: the server keeps an encrypted copy, no backup nag */
export function backupInfoLine(count, lastBackupAt, synced = false) {
  if (synced) return t('info.synced')
  const when = lastBackupAt ? new Date(lastBackupAt).toLocaleString(getLang() === 'it' ? 'it-IT' : 'en-GB') : t('common.never')
  return t('info.backup', { n: count, when })
}

/**
 * @param {boolean|null} persisted null = the browser cannot say (no line)
 * @param {boolean} [synced] in an active family: no "back up often" warning
 */
export function persistLine(persisted, synced = false) {
  if (persisted === null || (synced && !persisted)) return ''
  return t(persisted ? 'info.protected' : 'info.unprotected')
}

export const childLabel = (c) => c.charAt(0).toUpperCase() + c.slice(1)

/** One mapping row per v1 child: default "new tab", then every existing tab. */
export function mappingRows(children, tabs) {
  return children.map((child) => ({
    child,
    label: childLabel(child),
    options: [{ value: 'new', label: t('import.newTabOption', { name: childLabel(child) }) }, ...tabs.map((t) => ({ value: t.id, label: t.name }))],
  }))
}

/** User-facing text for an import error; null = not an import error (use the generic handler). */
export function importErrorMessage(e) {
  switch (e?.message) {
    case 'quota': return t('import.quota')
    case 'verify-failed': return t('import.verifyFailed')
    case 'bad-file': return t('import.badFile')
  }
  // Corrupt JSON/ZIP surfaces as parser errors: all mean "not a backup we can read".
  if (e instanceof SyntaxError || e?.name === 'SyntaxError') return t('import.badFile')
  return null
}

const place = (loc) => (loc === 'school' || loc === 'home' ? t('place.' + loc) : loc)

/**
 * Export stops at the first item without a readable photo ('missing-photo:<itemId>'):
 * name that item so the user can find and fix it. null = not that error.
 * @param {{ items?:any[], tabs?:any[] }} [ctx]  current store data
 */
export function missingPhotoMessage(e, { items = [], tabs = [] } = {}) {
  const id = /^missing-photo:(.*)$/.exec(e?.message ?? '')?.[1]
  if (id === undefined) return null
  const it = items.find((i) => i.id === id)
  const name = String(it?.label ?? '').trim() || t('common.unnamed')
  const where = [tabs.find((tab) => tab.id === it?.tabId)?.name, place(it?.location)].filter(Boolean).join(', ')
  return t('error.missingPhoto', { name, where: where ? ` (${where})` : '' })
}

// Error codes thrown by db.js / store.js / photos.js, as the user should read them.
const ERROR_KEY = {
  'not-found': 'error.notFound',
  'last-tab': 'error.lastTab',
  'empty-name': 'error.emptyName',
  'bad-data-url': 'error.badDataUrl',
  'rotate-missing': 'rotate.missingPhoto',
  'encode-failed': 'rotate.failed',
  'not-an-image': 'rotate.unreadable',
  'backup-verify-failed': 'error.backupFailed',
  'backup-too-large': 'error.backupTooLarge',
  'wipe-failed': 'wipe.failed',
}

/** User-facing text for any failed action (see reportError). */
export function errorMessage(e, ctx) {
  return missingPhotoMessage(e, ctx) ?? (ERROR_KEY[e?.message] ? t(ERROR_KEY[e.message]) : t('error.generic', { message: e?.message ?? e }))
}

/** User-facing text for a failed export: known codes, else "Esportazione non riuscita: …". */
export function exportErrorMessage(e, ctx) {
  return missingPhotoMessage(e, ctx) ?? (ERROR_KEY[e?.message] ? t(ERROR_KEY[e.message]) : t('menu.exportFailed', { message: e?.message ?? e }))
}

/** Import summary; before the first v2 backup, remind the user to make one. */
export function importDoneText(summary, lastBackupAt) {
  return lastBackupAt ? summary : summary + t('import.backupReminder')
}

/** Drop the tapped "Da rifare" entry by position (id-less entries can look identical). */
export function removeTodo(list, index) {
  return list.filter((_, i) => i !== index)
}


const REASONS = ['incomplete', 'unknown-place', 'unreadable-photo', 'missing-tab', 'missing-photo']
// Stored codes are translated; legacy entries (old Italian text) and unknown codes show as-is.
const reasonText = (r) => (REASONS.includes(r) ? t('import.reason.' + r) : r)

/** Readable parts of a failure; empty parts are skipped. */
export function failureParts(f) {
  return {
    title: f.label || t('common.unnamed'),
    detail: [f.tabName, place(f.location), reasonText(f.reason)].filter(Boolean).join(' · '),
  }
}

/** <li> for a failure list; `extra` is trusted markup appended inside (e.g. a button). */
export function failureRow(f, extra = '') {
  const { title, detail } = failureParts(f)
  return `<li><div><strong>${esc(title)}</strong><br><span>${esc(detail)}</span></div>${extra}</li>`
}

/**
 * A tapped button value is only final once confirmed. 'secondary' (partial import) needs the
 * user's yes; returns undefined when declined so the dialog stays open and nothing is chosen.
 */
export function confirmedChoice(choice, confirmFn) {
  if (choice === 'secondary' && !confirmFn()) return undefined
  return choice
}

/** "N capi non si possono importare" */
export const blockedTitle = (n) => t('import.blockedTitle', { n })
