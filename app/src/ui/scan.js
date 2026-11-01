// In-app QR scan for invites and recovery kits, only where the browser can decode QR codes itself
// (BarcodeDetector): no scanning library is shipped for the others, which paste the link instead.
import { t } from '../i18n.js'
import { openModal } from './dialogs.js'

export const canScan = () => typeof window !== 'undefined' && 'BarcodeDetector' in window

/** Button markup for a dialog; empty where scanning is not possible. */
export const scanButton = () => (canScan() ? `<button type="button" data-scan>${t('family.scan.go')}</button>` : '')

/**
 * Rear camera until a QR code is read or the user cancels.
 * @returns {Promise<string|null>} the code's text, null when cancelled
 */
export function scanQr() {
  const d = document.createElement('dialog')
  d.innerHTML = `<form method="dialog"><h3>${t('family.scan.title')}</h3>
    <video class="scanVideo" playsinline muted></video>
    <p class="plain err" role="alert"></p><button value="" class="cancel">${t('common.cancel')}</button></form>`
  document.body.append(d)
  let stream = null
  let timer = null
  let result = null
  const stop = () => { clearTimeout(timer); stream?.getTracks().forEach((tr) => tr.stop()) }
  const done = new Promise((resolve) => d.addEventListener('close', () => { stop(); d.remove(); resolve(result) }, { once: true }))
  openModal(d)
  ;(async () => {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false })
      if (!d.open) { s.getTracks().forEach((tr) => tr.stop()); return } // cancelled while asking
      stream = s
      const video = d.querySelector('video')
      video.srcObject = s
      await video.play()
      const detector = new window.BarcodeDetector({ formats: ['qr_code'] })
      const tick = async () => {
        if (!d.open) return
        try {
          const code = (await detector.detect(video))[0]?.rawValue
          if (code) { result = code; d.close(); return }
        } catch { /* frame not ready yet */ }
        timer = setTimeout(tick, 250)
      }
      tick()
    } catch {
      d.querySelector('.err').textContent = t('family.scan.failed')
    }
  })()
  return done
}
