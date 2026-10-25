// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'

const order = []
let blockedCb
vi.mock('../src/wipe.js', () => ({ wipeAll: vi.fn(async ({ onBlocked }) => { order.push('wipe'); blockedCb = onBlocked; await onBlocked?.(); order.push('wiped') }) }))
const { eraseEverything, openWipeFlow } = await import('../src/ui/wipeFlow.js')
const { setLang } = await import('../src/i18n.js')

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
  HTMLDialogElement.prototype.close = function () { if (!this.open) return; this.removeAttribute('open'); setTimeout(() => this.dispatchEvent(new Event('close')), 0) }
  globalThis.requestAnimationFrame = (f) => setTimeout(f, 0)
})
beforeEach(() => { document.body.innerHTML = ''; order.length = 0; setLang('it') })

describe('eraseEverything', () => {
  it('wipes inside the busy overlay, shows the blocked message, then reloads', async () => {
    let shown = null
    const reload = vi.fn(() => order.push('reload'))
    const { wipeAll } = await import('../src/wipe.js')
    wipeAll.mockImplementationOnce(async ({ onBlocked }) => {
      order.push('wipe'); onBlocked()
      shown = document.querySelector('dialog.busy')?.textContent
      order.push('wiped')
    })
    await eraseEverything({ db: {}, reload })
    expect(shown).toBe("Chiudi le altre schede di A/R per completare l'eliminazione.")
    expect(order).toEqual(['wipe', 'wiped', 'reload'])
    expect(document.querySelector('dialog.busy')).toBeNull()
  })
  it('reports a failure, then reloads', async () => {
    const { wipeAll } = await import('../src/wipe.js')
    wipeAll.mockRejectedValueOnce(new Error('x'))
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {})
    const reload = vi.fn()
    await eraseEverything({ db: {}, reload })
    expect(alertSpy).toHaveBeenCalledWith(expect.stringContaining('Non sono riuscito'))
    expect(reload).toHaveBeenCalled()
  })
})

describe('Enter in the confirmation input', () => {
  const open = () => {
    const erase = vi.fn(async () => {})
    openWipeFlow({ db: {}, onExport: async () => {}, erase })
    document.querySelector('[data-wipe="continue"]').click()
    const input = document.querySelector('#wipeWord')
    const enter = (v) => { input.value = v; input.dispatchEvent(new Event('input')); input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })) }
    return { erase, enter }
  }
  it('does nothing unless the word matches', () => {
    const { erase, enter } = open()
    enter('elimina')
    expect(erase).not.toHaveBeenCalled()
  })
  it('confirms when it matches', () => {
    const { erase, enter } = open()
    enter('ELIMINA')
    expect(erase).toHaveBeenCalledOnce()
  })
  it('a failing export is reported, not thrown', async () => {
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {})
    openWipeFlow({ db: {}, onExport: async () => { throw new Error('boom') }, erase: vi.fn() })
    document.querySelector('[data-wipe="export"]').click()
    await new Promise((r) => setTimeout(r, 10))
    expect(alertSpy).toHaveBeenCalled()
  })
})
