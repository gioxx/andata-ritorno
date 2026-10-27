// Import flow UI: pick a file, map v1 children to tabs, confirm partial imports, show the result.
// All parsing/writing lives in backup/importer.js; this file only asks questions.
import { store, load, runExclusive } from '../store.js'
import { prepareImport, commitImport, formatSummary, ImportBlocked } from '../backup/importer.js'
import { esc } from './esc.js'
import { reportError, openModal } from './dialogs.js'
import { mappingRows, importErrorMessage, blockedTitle, failureRow, confirmedChoice, importDoneText } from './model.js'
import { getMeta } from '../db.js'
import { getFamily } from '../sync/family.js'
import { familyHooks } from './familyDialogs.js'
import { t } from '../i18n.js'

let busyDlg = null

/** Blocking "Attendere…" overlay while ZIPs are built/parsed synchronously; always removed. */
export async function withBusy(fn) {
  if (busyDlg) return fn() // nested: the outer call owns the overlay
  const d = busyDlg = document.createElement('dialog')
  d.className = 'busy'
  d.textContent = t('import.busy')
  d.addEventListener('cancel', (e) => e.preventDefault())
  document.body.append(d)
  d.showModal()
  // Let the browser paint the overlay before the synchronous work starts.
  await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)))
  try { return await fn() } finally { d.close(); d.remove(); busyDlg = null }
}

/** Show a one-off dialog; `html` buttons carry data-result, resolves with it (null on Esc). */
function ask(html, { collect } = {}) {
  const d = document.createElement('dialog')
  d.innerHTML = `<form method="dialog">${html}</form>`
  document.body.append(d)
  return new Promise((resolve) => {
    let result = null
    d.addEventListener('click', (e) => {
      const b = e.target.closest('[data-result]')
      if (!b) return
      const choice = confirmedChoice(b.dataset.result, () => confirm(t('import.confirmPartial')))
      if (choice === undefined) return // declined: later dismissal must resolve null, not this button
      result = collect && choice ? { result: choice, value: collect(d) } : choice
      d.close()
    })
    d.addEventListener('close', () => { d.remove(); resolve(result) })
    openModal(d)
  })
}

const askMapping = (children) => ask(`
  <h3>${t('import.mappingTitle')}</h3>
  ${mappingRows(children, store.tabs).map((r, i) => `<label class="maprow">${esc(r.label)}
    <select data-child="${esc(r.child)}" aria-label="${esc(r.child)}">${r.options.map((o) => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('')}</select></label>`).join('')}
  <div class="row"><button type="button" class="primary" data-result="ok">${t('import.continue')}</button></div>
  <button type="button" class="cancel" data-result="">${t('common.cancel')}</button>`, {
  collect: (d) => Object.fromEntries([...d.querySelectorAll('select[data-child]')].map((s) => [s.dataset.child, s.value])),
})

const askBlocked = (failures, others) => ask(`
  <h3>${blockedTitle(failures.length)}</h3>
  <ul class="failures">${failures.map((f) => failureRow(f)).join('')}</ul>
  <p class="note">${t('import.blockedTip')}</p>
  <div class="row"><button type="button" class="primary" data-result="">${t('common.cancel')}</button>
  ${others ? `<button type="button" data-result="secondary">${t('import.others', { n: others })}</button>` : ''}</div>`)

const showMessage = (text) => ask(`<h3>${t('import.title')}</h3><p>${esc(text)}</p><div class="row"><button type="button" class="primary" data-result="ok">${t('common.ok')}</button></div>`)

/** Whole import, from a picked file to the summary. Never throws: errors are reported. */
export async function importFile(db, file) {
  // The import is planned from a DB snapshot and verified after: no store mutation may run in
  // between, so it holds the mutation queue (pending ones finish first, under the overlay).
  let summary
  let reloadError = null
  try {
    summary = await withBusy(() => runExclusive(async () => {
      try {
        const s = await prepareAndCommit(db, file)
        // The import is committed: a reload problem must not be reported as a failed import.
        if (s) await load(db).catch((e) => { reloadError = e })
        return s
      } catch (e) {
        // The failure may be past the write (verify-failed): make the UI match the DB anyway.
        await load(db).catch(() => {})
        throw e
      }
    }))
  } catch (e) {
    const msg = importErrorMessage(e)
    if (msg) alert(msg)
    else reportError(e)
    return
  }
  if (!summary) return
  // A failed read only costs an extra reminder.
  const lastBackupAt = await getMeta(db, 'lastBackupAt').catch(() => null)
  await showMessage(importDoneText(formatSummary(summary), lastBackupAt))
  if (reloadError) alert(t('import.reloadFailed', { message: reloadError?.message ?? reloadError }))
  // A backup made in a family carries its kit: a phone outside any family can rejoin with it.
  if (summary.familyKit && !(await getFamily(db).catch(() => true))) {
    const go = await ask(`<h3>${t('family.restore')}</h3><p>${t('import.kitFound')}</p>
      <div class="row"><button type="button" class="primary" data-result="restore">${t('family.restore')}</button></div>
      <button type="button" class="cancel" data-result="">${t('family.notNow')}</button>`)
    if (go === 'restore') await familyHooks.onRestore({ kit: summary.familyKit }).catch(reportError)
  }
}

/** Runs inside runExclusive: db-level calls and dialogs only, never a queued store action. */
async function prepareAndCommit(db, file) {
  let prepared = await prepareImport(db, file)
  if (prepared.needsMapping.length) {
    const answer = await hideBusyWhile(() => askMapping(prepared.needsMapping))
    if (!answer) return null
    prepared = await prepareImport(db, file, { childMap: answer.value })
  }
  try {
    return await commitImport(db, prepared, { partial: false })
  } catch (e) {
    if (!(e instanceof ImportBlocked)) throw e
    const choice = await hideBusyWhile(() => askBlocked(e.failures, prepared.incoming.items.length))
    if (choice !== 'secondary') return null
    return commitImport(db, prepared, { partial: true })
  }
}

// Questions need the user's hands, so drop the overlay for them and bring it back after.
async function hideBusyWhile(fn) {
  const d = busyDlg
  d?.close()
  try { return await fn() } finally { if (d?.isConnected) d.showModal() }
}

/** Change the text of the busy overlay (no-op when it is not shown). */
export function setBusyMessage(text) { if (busyDlg) busyDlg.textContent = text }

let input = null
/** Open the file picker (must be called inside the tap's click handler). */
export function pickImportFile(db) {
  if (!input) {
    input = Object.assign(document.createElement('input'), { type: 'file', accept: '.zip,.json,application/zip,application/json', hidden: true })
    document.body.append(input)
    input.addEventListener('change', () => {
      const f = input.files[0]; input.value = ''
      if (f) importFile(input.db, f)
    })
  }
  input.db = db
  input.click()
}
