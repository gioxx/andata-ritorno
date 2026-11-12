// A/R moved from app.ar.gioxx.org to app.ar.gxware.org. The data lives in this origin's IndexedDB
// and cannot follow by itself, so the old address no longer runs the app: it only lets the user
// save a backup and open the new address, where the backup is imported (with the family kit).

import { t, onLangChange } from '../i18n.js'

export const NEW_ORIGIN = 'https://app.ar.gxware.org'
const OLD_HOSTS = new Set(['app.ar.gioxx.org'])

/** Pure, for tests. */
export function isOldHost(hostname) {
  return OLD_HOSTS.has(hostname)
}

/** The same page on the new origin (path, query and fragment kept: invite and licence links carry them). */
export function newAddressOf(loc) {
  return NEW_ORIGIN + loc.pathname + loc.search + loc.hash
}

/**
 * Takes over the old origin. With nothing saved here there is nothing to carry: straight to the new
 * address. Otherwise the move screen, with the backup button.
 * @param {HTMLElement} root
 * @param {{hasData: boolean, onExport: () => Promise<boolean>}} o
 */
export function renderMoved(root, { hasData, onExport }) {
  if (!hasData) {
    location.replace(NEW_ORIGIN + '/')
    return
  }
  let saved = false
  const draw = () => {
    root.innerHTML = `<div class="welcome desktop-gate moved">
    <h1>${t('moved.title')}</h1>
    <p>${t('moved.lead', { url: NEW_ORIGIN.replace('https://', '') })}</p>
    <ol>
      <li>${t('moved.step1')}</li>
      <li>${t('moved.step2')}</li>
      <li>${t('moved.step3')}</li>
    </ol>
    <p class="hint">${t('moved.family')}</p>
    <button class="primary" id="movedExport">${t(saved ? 'moved.exportAgain' : 'moved.export')}</button>
    <a class="moved-open" id="movedOpen" href="${NEW_ORIGIN}/" rel="noopener">${t('moved.open')}</a>
    <p class="hint">${t('moved.after')}</p>
  </div>`
  }
  draw()
  onLangChange(draw)
  root.addEventListener('click', async (e) => {
    if (!e.target.closest('#movedExport')) return
    if (await onExport()) { saved = true; draw() }
  })
}
