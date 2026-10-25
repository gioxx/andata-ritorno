// iOS Safari wipes site data after ~7 days without a visit, unless the app is installed.
import { t, onLangChange } from '../i18n.js'
import { installSteps, currentPlatform, isStandalone } from '../platform.js'

const KEY = 'ar-ios-banner'

export function shouldShowIosBanner(platform, standalone) {
  if (platform !== 'ios' || standalone) return false
  try { return sessionStorage.getItem(KEY) !== '1' } catch { return true }
}

export function dismissIosBanner() {
  try { sessionStorage.setItem(KEY, '1') } catch { /* shown again next load */ }
}

/** Mounts the banner above #app; no-op when not needed. */
export function initIosBanner() {
  if (!shouldShowIosBanner(currentPlatform(), isStandalone())) return
  const el = document.createElement('aside')
  el.className = 'ios-banner'
  el.setAttribute('role', 'region')
  const draw = () => {
    el.setAttribute('aria-label', t('ios.bannerLabel'))
    el.innerHTML = `<p>${t('ios.banner')}</p><ol>${installSteps('ios').map((k) => `<li>${t(k)}</li>`).join('')}</ol>
      <button type="button" class="ios-ok">${t('ios.gotIt')}</button>`
  }
  draw()
  onLangChange(draw)
  el.addEventListener('click', (e) => {
    if (!e.target.closest('.ios-ok')) return
    dismissIosBanner()
    el.remove()
  })
  document.body.prepend(el)
}
