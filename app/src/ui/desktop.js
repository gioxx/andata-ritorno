// On a computer the app makes little sense (it's built around the phone camera and one-tap moves):
// invite the visitor to open it on the phone, but let them carry on if they really want to.

import { inviteFooter } from './about.js'
import { t, onLangChange } from '../i18n.js'
import { installSteps } from '../platform.js'

const KEY = 'ar-desktop-ok'

/**
 * Pure decision, so it can be tested without a browser.
 * @param {{standalone: boolean, coarsePointer: boolean, finePointer: boolean, touchPoints: number, width: number}} env
 * @param {boolean} dismissed the visitor already chose "Continua dal computer" in this browser
 */
export function shouldShowDesktopGate(env, dismissed) {
  if (dismissed || env.standalone) return false
  return env.finePointer && !env.coarsePointer && env.touchPoints === 0 && env.width >= 900
}

function readEnv() {
  const mq = (q) => window.matchMedia?.(q).matches ?? false
  return {
    standalone: mq('(display-mode: standalone)') || navigator.standalone === true,
    coarsePointer: mq('(any-pointer: coarse)'),
    finePointer: mq('(pointer: fine)'),
    touchPoints: navigator.maxTouchPoints || 0,
    width: window.innerWidth,
  }
}

function dismissed() {
  try { return localStorage.getItem(KEY) === '1' } catch { return false }
}

/**
 * Shows the "use it on your phone" screen when needed; resolves once the app may start.
 * @param {HTMLElement} root
 * @returns {Promise<void>}
 */
export function desktopGate(root) {
  if (!shouldShowDesktopGate(readEnv(), dismissed())) return Promise.resolve()
  // Redrawn on a language change; the button is re-wired each time.
  const draw = () => {
    root.innerHTML = `<div class="welcome desktop-gate">
    <h1>${t('desktop.title')}</h1>
    <p>${t('desktop.lead')}</p>
    <img class="qr" src="/qr-ar.svg" width="200" height="200" alt="${t('desktop.qrAlt')}">
    <p>${t('desktop.step1')}</p>
    ${['android', 'ios'].map((p) => `<h2>${t('install.' + p + 'Title')}</h2>
    <ol>${installSteps(p).map((k) => `<li>${t(k)}</li>`).join('')}</ol>`).join('')}
    <button class="ghost" id="desktopContinue">${t('desktop.continue')}</button>
    ${inviteFooter()}
  </div>`
  }
  draw()
  return new Promise((resolve) => {
    const off = onLangChange(draw)
    root.addEventListener('click', function onClick(e) {
      if (!e.target.closest('#desktopContinue')) return
      root.removeEventListener('click', onClick)
      off()
      try { localStorage.setItem(KEY, '1') } catch { /* private mode: ask again next time */ }
      root.innerHTML = ''
      resolve()
    })
  })
}
