// Import flow UI: pick a file, map v1 children to tabs, confirm partial imports, show the result.
// All parsing/writing lives in backup/importer.js; this file only asks questions.
import { store, load } from '../store.js'
import { prepareImport, commitImport, formatSummary, ImportBlocked } from '../backup/importer.js'
import { esc } from './render.js'
import { reportError } from './dialogs.js'
import { mappingRows, importErrorMessage, blockedTitle, failureRow, confirmedChoice, importDoneText } from './model.js'
import { getMeta } from '../db.js'

let busyDlg = null

/** Blocking "Attendere…" overlay while ZIPs are built/parsed synchronously; always removed. */
export async function withBusy(fn) {
  if (busyDlg) return fn() // nested: the outer call owns the overlay
  const d = busyDlg = document.createElement('dialog')
  d.className = 'busy'
  d.textContent = 'Attendere…'
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
      const choice = confirmedChoice(b.dataset.result, () => confirm('I capi elencati non verranno importati e finiranno nella lista "Da rifare". Continuare?'))
      if (choice === undefined) return // declined: later dismissal must resolve null, not this button
      result = collect && choice ? { result: choice, value: collect(d) } : choice
      d.close()
    })
    d.addEventListener('close', () => { d.remove(); resolve(result) })
    d.showModal()
  })
}

const askMapping = (children) => ask(`
  <h3>Dove metto i capi del backup?</h3>
  ${mappingRows(children, store.tabs).map((r, i) => `<label class="maprow">${esc(r.label)}
    <select data-child="${esc(r.child)}" aria-label="${esc(r.child)}">${r.options.map((o) => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('')}</select></label>`).join('')}
  <div class="row"><button type="button" class="primary" data-result="ok">Continua</button></div>
  <button type="button" class="cancel" data-result="">Annulla</button>`, {
  collect: (d) => Object.fromEntries([...d.querySelectorAll('select[data-child]')].map((s) => [s.dataset.child, s.value])),
})

const askBlocked = (failures, others) => ask(`
  <h3>${blockedTitle(failures.length)}</h3>
  <ul class="failures">${failures.map((f) => failureRow(f)).join('')}</ul>
  <p class="note">Consiglio: rifai la foto di questi capi nella vecchia app, esporta di nuovo e riprova.</p>
  <div class="row"><button type="button" class="primary" data-result="">Annulla</button>
  ${others ? `<button type="button" data-result="secondary">Importa gli altri ${others}</button>` : ''}</div>`)

const showMessage = (text) => ask(`<h3>Importazione</h3><p>${esc(text)}</p><div class="row"><button type="button" class="primary" data-result="ok">OK</button></div>`)

/** Whole import, from a picked file to the summary. Never throws: errors are reported. */
export async function importFile(db, file) {
  let summary
  try {
    summary = await withBusy(async () => {
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
    })
  } catch (e) {
    // The failure may be past the write (verify-failed): make the UI match the DB anyway.
    await load(db).catch(() => {})
    const msg = importErrorMessage(e)
    if (msg) alert(msg)
    else reportError(e)
    return
  }
  if (!summary) return
  // The import is committed: a reload problem must not be reported as a failed import.
  let reloadError = null
  try { await load(db) } catch (e) { reloadError = e }
  // A failed read only costs an extra reminder.
  const lastBackupAt = await getMeta(db, 'lastBackupAt').catch(() => null)
  await showMessage(importDoneText(formatSummary(summary), lastBackupAt))
  if (reloadError) alert("Import completato, ma l'elenco non si è aggiornato: riapri l'app. " + (reloadError?.message ?? reloadError))
}

// Questions need the user's hands, so drop the overlay for them and bring it back after.
async function hideBusyWhile(fn) {
  const d = busyDlg
  d?.close()
  try { return await fn() } finally { if (d?.isConnected) d.showModal() }
}

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
