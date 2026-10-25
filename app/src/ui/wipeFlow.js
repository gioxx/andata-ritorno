// "Delete all data": explain, offer a backup, then require the typed word. Nothing is erased
// before the last button, and that button stays disabled until the word matches exactly.
import { t } from '../i18n.js'
import { store, runExclusive } from '../store.js'
import { wipeAll } from '../wipe.js'
import { reportError, openModal } from './dialogs.js'

const unsavedHtml = () => (store.unsaved > 0 ? `<p class="plain warn">${t('wipe.unsaved', { n: store.unsaved })}</p>` : '')

function show(html) {
  const d = document.createElement('dialog')
  d.innerHTML = html
  document.body.append(d)
  d.addEventListener('close', () => d.remove(), { once: true })
  return d
}

/** Erase for real, alone in the mutation queue; on failure the app reloads onto what is left. */
export async function eraseEverything({ db, reload = () => location.reload() }) {
  try {
    await runExclusive(() => wipeAll({ db }))
  } catch {
    reportError(new Error('wipe-failed'))
  }
  reload() // welcome screen after success; after a failure the closed connection is reopened
}

/** @param {{ db: any, onExport: () => Promise<void>, erase?: (o: {db: any}) => Promise<void> }} deps */
export function openWipeFlow({ db, onExport, erase = eraseEverything }) {
  const step1 = show(`<form method="dialog"><h3>${t('wipe.title')}</h3>
    <p class="plain">${t('wipe.body')}</p>
    <div id="wipeUnsaved">${unsavedHtml()}</div>
    <div class="wipe-actions">
      <button type="button" data-wipe="export">${t('wipe.export')}</button>
      <button type="button" class="danger" data-wipe="continue">${t('wipe.continue')}</button>
      <button value="" class="cancel">${t('common.cancel')}</button>
    </div></form>`)
  step1.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-wipe]')?.dataset.wipe
    if (act === 'export') {
      await onExport()
      step1.querySelector('#wipeUnsaved').innerHTML = unsavedHtml() // the backup zeroed the counter
    } else if (act === 'continue') {
      step1.close()
      openConfirm({ db, erase })
    }
  })
  openModal(step1)
}

function openConfirm({ db, erase }) {
  const word = t('wipe.word')
  const d = show(`<form method="dialog"><h3>${t('wipe.title')}</h3>
    <p class="plain">${t('wipe.confirmText', { word })}</p>
    <input type="text" id="wipeWord" aria-label="${t('wipe.word')}" autocomplete="off" autocapitalize="characters" spellcheck="false">
    <div class="wipe-actions">
      <button type="button" class="danger" id="wipeGo" disabled>${t('wipe.confirm')}</button>
      <button value="" class="cancel">${t('common.cancel')}</button>
    </div></form>`)
  const input = d.querySelector('#wipeWord')
  const go = d.querySelector('#wipeGo')
  // Exact match on purpose (case-sensitive, current language): a slip must not erase everything.
  const matches = () => input.value.trim() === word
  input.addEventListener('input', () => { go.disabled = !matches() })
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); if (matches()) go.click() } })
  go.addEventListener('click', () => {
    if (!matches()) return
    go.disabled = true
    d.close()
    erase({ db })
  })
  openModal(d)
}
