// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { platformOf, installSteps } from '../src/platform.js'
import { renderWelcome } from '../src/ui/welcome.js'
import { t, setLang } from '../src/i18n.js'
import { shouldShowIosBanner, dismissIosBanner, initIosBanner } from '../src/ui/iosBanner.js'

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'

describe('platformOf', () => {
  it('detects iPhone, iPadOS with desktop UA, Android, desktop', () => {
    expect(platformOf({ ua: IPHONE, maxTouchPoints: 5 })).toBe('ios')
    expect(platformOf({ ua: MAC, maxTouchPoints: 5 })).toBe('ios')
    expect(platformOf({ ua: ANDROID, maxTouchPoints: 5 })).toBe('android')
    expect(platformOf({ ua: MAC, maxTouchPoints: 0 })).toBe('desktop')
    expect(platformOf({ ua: MAC, maxTouchPoints: 1 })).toBe('desktop')
    expect(platformOf({ ua: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15', maxTouchPoints: 5 })).toBe('ios')
    expect(platformOf({ ua: 'Mozilla/5.0 (iPod touch; CPU iPhone OS 15_0 like Mac OS X)', maxTouchPoints: 5 })).toBe('ios')
    expect(platformOf({ ua: 'Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 Chrome/120.0 Safari/537.36', maxTouchPoints: 5 })).toBe('android')
    expect(platformOf({ ua: 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 Chrome/120.0', maxTouchPoints: 10 })).toBe('desktop')
    expect(platformOf({ ua: 'Mozilla/5.0 (X11; Linux x86_64)', maxTouchPoints: 0 })).toBe('desktop')
  })
})

describe('installSteps', () => {
  beforeEach(() => setLang('it'))
  it('ios steps mention Condividi / Share in both languages', () => {
    const steps = installSteps('ios')
    expect(steps.length).toBe(3)
    expect(steps.map((k) => t(k)).join(' ')).toMatch(/Condividi.*Aggiungi alla schermata Home/s)
    setLang('en')
    expect(steps.map((k) => t(k)).join(' ')).toMatch(/Share.*Add to Home Screen/s)
  })
  it('android steps mention Installa app', () => {
    expect(installSteps('android').map((k) => t(k)).join(' ')).toMatch(/Installa app/)
  })
  it('other platforms get none', () => { expect(installSteps('desktop')).toEqual([]) })
})

describe('iOS banner', () => {
  beforeEach(() => sessionStorage.clear())
  it('shows only on iOS outside the installed app, until dismissed this session', () => {
    expect(shouldShowIosBanner('ios', false)).toBe(true)
    expect(shouldShowIosBanner('ios', true)).toBe(false)
    expect(shouldShowIosBanner('android', false)).toBe(false)
    dismissIosBanner()
    expect(shouldShowIosBanner('ios', false)).toBe(false)
  })
})

const setEnv = (ua, standalone = false, touch = 5) => {
  Object.defineProperty(navigator, 'userAgent', { value: ua, configurable: true })
  Object.defineProperty(navigator, 'maxTouchPoints', { value: touch, configurable: true })
  Object.defineProperty(navigator, 'standalone', { value: standalone, configurable: true })
}

describe('iOS banner DOM', () => {
  beforeEach(() => { sessionStorage.clear(); document.body.innerHTML = ''; setLang('it') })
  it('mounts on iOS Safari, dismisses with the session flag, redraws on language change', () => {
    setEnv(IPHONE)
    initIosBanner()
    const el = document.querySelector('.ios-banner')
    expect(el.querySelectorAll('li').length).toBe(3)
    setLang('en')
    expect(el.querySelector('.ios-ok').textContent).toBe('Got it')
    el.querySelector('.ios-ok').click()
    expect(document.querySelector('.ios-banner')).toBeNull()
    expect(sessionStorage.getItem('ar-ios-banner')).toBe('1')
    initIosBanner()
    expect(document.querySelector('.ios-banner')).toBeNull()
  })
  it('is absent when installed or not on iOS', () => {
    setEnv(IPHONE, true); initIosBanner()
    expect(document.querySelector('.ios-banner')).toBeNull()
    setEnv(ANDROID); initIosBanner()
    expect(document.querySelector('.ios-banner')).toBeNull()
  })
  it('survives sessionStorage throwing', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('x') })
    expect(shouldShowIosBanner('ios', false)).toBe(true)
    spy.mockRestore()
    const spy2 = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('x') })
    expect(() => dismissIosBanner()).not.toThrow()
    spy2.mockRestore()
  })
})

describe('welcome install block', () => {
  const draw = () => { const r = document.createElement('div'); renderWelcome(r, { onCreate() {}, onImport() {} }); return r }
  beforeEach(() => { sessionStorage.clear(); setLang('it') })
  it('shows Android steps on Android', () => {
    setEnv(ANDROID)
    expect(draw().querySelector('.install').textContent).toMatch(/Installa app/)
  })
  it('on iOS shows steps only after the banner is dismissed (never twice)', () => {
    setEnv(IPHONE)
    expect(draw().querySelector('.install')).toBeNull()
    dismissIosBanner()
    expect(draw().querySelector('.install').textContent).toMatch(/Condividi/)
  })
  it('shows nothing when installed or on desktop', () => {
    setEnv(ANDROID, true); expect(draw().querySelector('.install')).toBeNull()
    setEnv(MAC, false, 0); expect(draw().querySelector('.install')).toBeNull()
  })
})

describe('banner dismissal redraws the welcome screen', () => {
  it('shows the steps after "Ho capito" and keeps the typed name', () => {
    sessionStorage.clear(); document.body.innerHTML = ''; setLang('it'); setEnv(IPHONE)
    const root = document.createElement('div'); document.body.append(root)
    // Same wiring as main.js: onDismiss forces a welcome redraw.
    const draw = () => renderWelcome(root, { onCreate() {}, onImport() {} })
    draw()
    initIosBanner({ onDismiss: draw })
    expect(root.querySelector('.install')).toBeNull()
    root.querySelector('#firstTab').value = 'Nido'
    document.querySelector('.ios-ok').click()
    expect(root.querySelector('.install').textContent).toMatch(/Condividi/)
    expect(root.querySelector('#firstTab').value).toBe('Nido')
  })
})
