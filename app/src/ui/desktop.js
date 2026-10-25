// On a computer the app makes little sense (it's built around the phone camera and one-tap moves):
// invite the visitor to open it on the phone, but let them carry on if they really want to.

import { inviteFooter } from './about.js'

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
  root.innerHTML = `<div class="welcome desktop-gate">
    <h1>A/R è fatta per il telefono</h1>
    <p>Serve a fotografare i capi e spostarli tra casa e scuola con un tocco: usala sul telefono e aggiungila alla schermata Home.</p>
    <img class="qr" src="/qr-ar.svg" width="200" height="200" alt="QR code per aprire ar.gioxx.org sul telefono">
    <ol>
      <li>Inquadra il codice con la fotocamera del telefono, oppure apri <b>ar.gioxx.org</b>.</li>
      <li>In Chrome tocca il menu <b>⋮</b>.</li>
      <li>Scegli <b>Installa app</b> (o <b>Aggiungi a schermata Home</b>).</li>
    </ol>
    <button class="ghost" id="desktopContinue">Continua dal computer</button>
    ${inviteFooter()}
  </div>`
  return new Promise((resolve) => {
    root.querySelector('#desktopContinue').addEventListener('click', () => {
      try { localStorage.setItem(KEY, '1') } catch { /* private mode: ask again next time */ }
      root.innerHTML = ''
      resolve()
    }, { once: true })
  })
}
