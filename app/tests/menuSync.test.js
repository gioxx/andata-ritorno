// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll } from 'vitest'

// The menu's sync listener, captured; getFamily counts the family section's redraws.
const listeners = []
vi.mock('../src/sync/engine.js', async (orig) => ({
  ...(await orig()),
  subscribeSync: vi.fn((fn) => { listeners.push(fn); return () => {} }),
}))
vi.mock('../src/sync/family.js', async (orig) => ({ ...(await orig()), getFamily: vi.fn(async () => null) }))

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
  window.matchMedia = () => ({ matches: false })
})

describe('menu and sync status', () => {
  it('redraws the family section on status changes, not on progress ticks', async () => {
    const { initMenu } = await import('../src/ui/menu.js')
    const { hooks } = await import('../src/ui/render.js')
    const { getFamily } = await import('../src/sync/family.js')
    const { syncStatus } = await import('../src/sync/engine.js')
    initMenu({ get: async () => [] })
    await hooks.onMenu().catch(() => {})
    await new Promise((r) => setTimeout(r, 10))
    expect(document.querySelector('dialog#menu[open]')).not.toBeNull()
    expect(listeners).toHaveLength(1)
    const before = getFamily.mock.calls.length
    listeners[0](syncStatus, { progress: { phase: 'push', done: 1, total: 3 } })
    listeners[0](syncStatus, { photoDownloads: { done: 1, total: 2 } })
    await new Promise((r) => setTimeout(r, 0))
    expect(getFamily.mock.calls.length).toBe(before)
    listeners[0](syncStatus, { state: 'idle', lastSyncAt: new Date().toISOString() })
    await new Promise((r) => setTimeout(r, 0))
    expect(getFamily.mock.calls.length).toBe(before + 1)
  })
})
