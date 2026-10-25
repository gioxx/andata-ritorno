// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { platformOf, installSteps } from '../src/platform.js'
import { t, setLang } from '../src/i18n.js'
import { shouldShowIosBanner, dismissIosBanner } from '../src/ui/iosBanner.js'

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'

describe('platformOf', () => {
  it('detects iPhone, iPadOS with desktop UA, Android, desktop', () => {
    expect(platformOf({ ua: IPHONE, maxTouchPoints: 5 })).toBe('ios')
    expect(platformOf({ ua: MAC, maxTouchPoints: 5 })).toBe('ios')
    expect(platformOf({ ua: ANDROID, maxTouchPoints: 5 })).toBe('android')
    expect(platformOf({ ua: MAC, maxTouchPoints: 0 })).toBe('desktop')
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
