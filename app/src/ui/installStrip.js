// One-time discreet invitation to install, shown on Android when the browser offers the prompt.
import { t, onLangChange } from '../i18n.js'
import { currentPlatform, isStandalone } from '../platform.js'
import { canPromptInstall, onInstallChange, promptInstall, shouldShowInstallStrip, dismissInstallStrip } from '../install.js'

export function initInstallStrip() {
  const el = document.createElement('aside')
  el.className = 'install-strip'
  el.setAttribute('role', 'region')
  el.hidden = true
  const draw = () => {
    el.setAttribute('aria-label', t('install.stripLabel'))
    el.innerHTML = `<p>${t('install.strip')}</p>
      <button type="button" class="strip-go">${t('install.stripAction')}</button>
      <button type="button" class="strip-x" aria-label="${t('common.close')}">✕</button>`
  }
  const sync = () => {
    const show = shouldShowInstallStrip({ platform: currentPlatform(), canPrompt: canPromptInstall(), standalone: isStandalone() })
    if (show && el.hidden) { draw(); el.hidden = false }
    if (!show) el.hidden = true
  }
  onLangChange(() => { if (!el.hidden) draw() })
  onInstallChange(sync)
  el.addEventListener('click', async (e) => {
    if (e.target.closest('.strip-x')) { dismissInstallStrip(); sync(); return }
    if (!e.target.closest('.strip-go')) return
    if (await promptInstall() === 'accepted') dismissInstallStrip()
    sync()
  })
  document.body.prepend(el)
  sync()
}
