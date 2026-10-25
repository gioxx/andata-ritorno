// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { canApplyUpdate } from '../src/update.js'
import { initUpdateToast } from '../src/ui/updateToast.js'

describe('canApplyUpdate', () => {
  it('only when nothing is open or running', () => {
    expect(canApplyUpdate({ modalOpen: false, viewerOpen: false, busy: false })).toBe(true)
    expect(canApplyUpdate({ modalOpen: true, viewerOpen: false, busy: false })).toBe(false)
    expect(canApplyUpdate({ modalOpen: false, viewerOpen: true, busy: false })).toBe(false)
    expect(canApplyUpdate({ modalOpen: false, viewerOpen: false, busy: true })).toBe(false)
  })
})

describe('update toast', () => {
  beforeEach(() => { document.body.innerHTML = '' })
  const setup = () => {
    const updateSW = vi.fn(async () => {})
    let handlers
    const toast = initUpdateToast((h) => { handlers = h; return updateSW }, { poll: 5 })
    return { updateSW, handlers, toast }
  }

  it('appears on onNeedRefresh; ✕ hides it', () => {
    const { handlers } = setup()
    expect(document.querySelector('.update-toast')).toBeNull()
    handlers.onNeedRefresh()
    expect(document.querySelector('.update-toast').textContent).toContain('Nuova versione disponibile')
    document.querySelector('.up-x').click()
    expect(document.querySelector('.update-toast')).toBeNull()
  })

  it('click calls updateSW(true) when idle', () => {
    const { handlers, updateSW } = setup()
    handlers.onNeedRefresh()
    document.querySelector('.up-go').click()
    expect(updateSW).toHaveBeenCalledWith(true)
  })

  it('stays disabled with a hint while a dialog is open, then re-enables', async () => {
    const { handlers, updateSW } = setup()
    const d = document.createElement('dialog'); d.setAttribute('open', ''); document.body.append(d)
    handlers.onNeedRefresh()
    const go = document.querySelector('.up-go')
    expect(go.disabled).toBe(true)
    expect(document.querySelector('.update-toast .hint').hidden).toBe(false)
    go.click()
    expect(updateSW).not.toHaveBeenCalled()
    d.remove()
    await new Promise((r) => setTimeout(r, 30))
    expect(go.disabled).toBe(false)
    go.click()
    expect(updateSW).toHaveBeenCalledWith(true)
  })
})
