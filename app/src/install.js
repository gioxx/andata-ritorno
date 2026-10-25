// Native "install app" prompt (Chromium/Android). The browser fires `beforeinstallprompt` once;
// we keep the event so the menu or the strip can trigger the prompt on a user tap.
const STRIP_KEY = 'ar-install-strip'

let deferred = null
let started = false
const listeners = new Set()
const changed = () => { for (const fn of [...listeners]) fn() }

/** Start listening; call once, early (the event can fire before the UI is ready). */
export function initInstall() {
  if (started) return
  started = true
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault() // no mini-infobar: we offer the prompt ourselves
    deferred = e
    changed()
  })
  window.addEventListener('appinstalled', () => {
    deferred = null
    dismissInstallStrip() // installed: the invitation has no purpose any more
    changed()
  })
}

export const canPromptInstall = () => deferred !== null

/** @returns {() => void} unsubscribe */
export function onInstallChange(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** @returns {Promise<'accepted'|'dismissed'|'unavailable'>} */
export async function promptInstall() {
  const ev = deferred
  if (!ev) return 'unavailable'
  deferred = null // the browser allows one prompt per event
  changed()
  try {
    await ev.prompt()
    return (await ev.userChoice).outcome
  } catch {
    return 'unavailable' // the browser refused (e.g. prompt already used)
  }
}

export function dismissInstallStrip() {
  try { localStorage.setItem(STRIP_KEY, '1') } catch { /* shown again next load */ }
}

/** Android only: iOS has its own banner, desktop gets the invite screen. */
export function shouldShowInstallStrip({ platform, canPrompt, standalone }) {
  if (platform !== 'android' || !canPrompt || standalone) return false
  try { return localStorage.getItem(STRIP_KEY) !== '1' } catch { return true }
}
