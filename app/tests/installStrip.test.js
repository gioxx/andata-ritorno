// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { initInstall } from '../src/install.js'
import { initInstallStrip } from '../src/ui/installStrip.js'

const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36'
const offer = (outcome = 'accepted') => window.dispatchEvent(Object.assign(new Event('beforeinstallprompt', { cancelable: true }), { prompt: async () => {}, userChoice: Promise.resolve({ outcome }) }))

describe('install strip', () => {
  beforeEach(() => { document.body.innerHTML = ''; localStorage.clear(); initInstall(); window.dispatchEvent(new Event('appinstalled')); localStorage.clear(); window.matchMedia = () => ({ matches: false }) })

  it('is hidden on android until the prompt is offered, then shown', () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(ANDROID)
    initInstallStrip()
    const el = document.querySelector('.install-strip')
    expect(el.hidden).toBe(true)
    offer()
    expect(el.hidden).toBe(false)
    expect(el.textContent).toContain("Installa A/R sul telefono per aprirla come un'app.")
  })
  it('✕ hides it for good', () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(ANDROID)
    initInstallStrip(); offer()
    document.querySelector('.strip-x').click()
    expect(document.querySelector('.install-strip').hidden).toBe(true)
    expect(localStorage.getItem('ar-install-strip')).toBe('1')
  })
  it('never shows on desktop', () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (X11; Linux x86_64)')
    initInstallStrip(); offer()
    expect(document.querySelector('.install-strip').hidden).toBe(true)
  })
})
