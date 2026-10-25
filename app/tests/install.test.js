// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { initInstall, canPromptInstall, promptInstall, shouldShowInstallStrip, dismissInstallStrip } from '../src/install.js'

const fire = (outcome = 'accepted') => {
  const ev = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), {
    prompt: vi.fn(async () => {}), userChoice: Promise.resolve({ outcome }),
  })
  window.dispatchEvent(ev)
  return ev
}

describe('install prompt', () => {
  beforeEach(() => { localStorage.clear(); initInstall(); window.dispatchEvent(new Event('appinstalled')); localStorage.clear() })

  it('is unavailable until the browser offers it', async () => {
    expect(canPromptInstall()).toBe(false)
    expect(await promptInstall()).toBe('unavailable')
  })

  it('keeps the event (and cancels the mini-infobar) once offered', () => {
    const ev = fire()
    expect(ev.defaultPrevented).toBe(true)
    expect(canPromptInstall()).toBe(true)
  })

  it('prompts and returns the user choice; the event is single use', async () => {
    const ev = fire('dismissed')
    expect(await promptInstall()).toBe('dismissed')
    expect(ev.prompt).toHaveBeenCalledOnce()
    expect(canPromptInstall()).toBe(false)
  })

  it('forgets the event on appinstalled and never shows the strip again', () => {
    fire()
    window.dispatchEvent(new Event('appinstalled'))
    expect(canPromptInstall()).toBe(false)
    expect(localStorage.getItem('ar-install-strip')).toBe('1')
  })

  it('notifies listeners on changes', async () => {
    const { onInstallChange } = await import('../src/install.js')
    const fn = vi.fn()
    const off = onInstallChange(fn)
    fire()
    expect(fn).toHaveBeenCalled()
    off()
  })
})

describe('shouldShowInstallStrip', () => {
  beforeEach(() => localStorage.clear())
  const ok = { platform: 'android', canPrompt: true, standalone: false }
  it('shows only on android with a prompt, not installed, not dismissed', () => {
    expect(shouldShowInstallStrip(ok)).toBe(true)
    expect(shouldShowInstallStrip({ ...ok, platform: 'ios' })).toBe(false)
    expect(shouldShowInstallStrip({ ...ok, platform: 'desktop' })).toBe(false)
    expect(shouldShowInstallStrip({ ...ok, platform: 'other' })).toBe(false)
    expect(shouldShowInstallStrip({ ...ok, canPrompt: false })).toBe(false)
    expect(shouldShowInstallStrip({ ...ok, standalone: true })).toBe(false)
    dismissInstallStrip()
    expect(shouldShowInstallStrip(ok)).toBe(false)
  })
  it('survives unavailable storage', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied') })
    expect(shouldShowInstallStrip(ok)).toBe(true)
    spy.mockRestore()
  })
})
