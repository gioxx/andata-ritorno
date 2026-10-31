// First-run screen, shown while there are no tabs. Importing a backup must not create a tab first.
import { esc } from './esc.js'
import { t } from '../i18n.js'
import { installSteps, currentPlatform, isStandalone } from '../platform.js'
import { shouldShowIosBanner } from './iosBanner.js'

/**
 * @param {HTMLElement} root
 * @param {{onCreate(name: string): void, onImport(file: File): void, onInvite(): void, onRestore(): void, onHaveCode(): void}} cb
 */
export function renderWelcome(root, { onCreate, onImport, onInvite = () => {}, onRestore = () => {}, onHaveCode = () => {} }) {
  // Keep the typed name if the screen is redrawn (e.g. store notifications) while typing.
  const prev = root.querySelector('#firstTab')?.value ?? ''
  // Install hint for the detected platform; nothing once installed.
  // On iOS the banner already lists the steps while it is visible: don't repeat them.
  const platform = currentPlatform(), standalone = isStandalone()
  const steps = standalone || shouldShowIosBanner(platform, standalone) ? [] : installSteps(platform)
  const install = steps.length ? `<div class="install"><p>${t('welcome.install')}</p><ol>${steps.map((k) => `<li>${t(k)}</li>`).join('')}</ol></div>` : ''
  root.innerHTML = `<div class="welcome">
    <h1>${t('welcome.title')}</h1>
    <input type="text" id="firstTab" maxlength="60" placeholder="${esc(t('welcome.placeholder'))}" aria-label="${esc(t('welcome.hint'))}" autocomplete="off" value="${esc(prev)}">
    <label for="firstTab" class="hint">${t('welcome.hint')}</label>
    <button class="primary" id="start" ${prev.trim() ? '' : 'disabled'}>${t('welcome.start')}</button>
    <button class="ghost" id="importBtn">${t('welcome.import')}</button>
    <button class="ghost" id="codeBtn">${t('family.haveCode')}</button>
    <button class="ghost" id="inviteBtn">${t('family.haveInvite')}</button>
    <button class="ghost" id="restoreBtn">${t('family.restore')}</button>
    <input type="file" id="importFile" accept=".zip,application/zip,application/json,.json" hidden>
    <p class="note">${t('welcome.note')}</p>
    ${install}
  </div>`
  const $ = (id) => root.querySelector('#' + id)
  const input = $('firstTab'), start = $('start'), file = $('importFile')
  input.addEventListener('input', () => { start.disabled = !input.value.trim() })
  const create = () => { if (input.value.trim()) onCreate(input.value.trim()) }
  start.addEventListener('click', create)
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') create() })
  $('importBtn').addEventListener('click', () => file.click())
  $('codeBtn').addEventListener('click', () => onHaveCode())
  $('inviteBtn').addEventListener('click', () => onInvite())
  $('restoreBtn').addEventListener('click', () => onRestore())
  file.addEventListener('change', () => {
    const f = file.files[0]; file.value = ''
    if (f) onImport(f)
  })
}
