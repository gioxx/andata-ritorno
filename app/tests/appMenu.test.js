// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { openWipeFlow } from '../src/ui/wipeFlow.js'
import { openUninstallSteps, openInstallSteps } from '../src/ui/appDialogs.js'
import { setLang } from '../src/i18n.js'

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
  HTMLDialogElement.prototype.close = function () { if (!this.open) return; this.removeAttribute('open'); setTimeout(() => this.dispatchEvent(new Event('close')), 0) }
})
beforeEach(() => { document.body.innerHTML = ''; setLang('it') })
afterEach(() => setLang('it'))

const toConfirm = () => {
  const erase = vi.fn(async () => {})
  openWipeFlow({ db: {}, onExport: async () => {}, erase })
  document.querySelector('[data-wipe="continue"]').click()
  const input = document.querySelector('#wipeWord'), go = document.querySelector('#wipeGo')
  const type = (v) => { input.value = v; input.dispatchEvent(new Event('input')) }
  return { erase, type, go }
}

describe('wipe confirmation', () => {
  it('erases nothing before the typed word', () => {
    const { erase, go } = toConfirm()
    expect(go.disabled).toBe(true)
    expect(erase).not.toHaveBeenCalled()
  })
  it('needs exactly ELIMINA (trimmed, case-sensitive)', () => {
    const { erase, type, go } = toConfirm()
    type('elimina'); expect(go.disabled).toBe(true)
    type('DELETE'); expect(go.disabled).toBe(true)
    type('  ELIMINA '); expect(go.disabled).toBe(false)
    go.click()
    expect(erase).toHaveBeenCalledOnce()
  })
  it('needs DELETE in English', () => {
    setLang('en')
    const { type, go } = toConfirm()
    type('ELIMINA'); expect(go.disabled).toBe(true)
    type('DELETE'); expect(go.disabled).toBe(false)
  })
})

describe('app dialogs', () => {
  it('uninstall dialog shows steps and the notice', () => {
    openUninstallSteps('android')
    expect(document.body.textContent).toContain("Disinstallare toglie solo l'icona")
    expect(document.body.textContent).toContain('Disinstalla')
  })
  it('desktop shows both platforms', () => {
    openInstallSteps('desktop')
    expect(document.body.textContent).toContain('Android')
    expect(document.body.textContent).toContain('iPhone')
  })
})

describe('menu', () => {
  it('hides "Installa app" when standalone', async () => {
    window.matchMedia = () => ({ matches: true })
    const { initMenu } = await import('../src/ui/menu.js')
    const { hooks } = await import('../src/ui/render.js')
    initMenu({ get: async () => [] })
    hooks.onMenu().catch(() => {})
    await new Promise((r) => setTimeout(r, 10))
    expect(document.querySelector('[data-menu="install"]')).toBeNull()
    expect(document.querySelector('[data-menu="wipe"]')).not.toBeNull()
  })
})
