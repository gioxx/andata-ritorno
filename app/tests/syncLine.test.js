// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { syncLineText, renderSyncLine, enableSyncLine, initPullToRefresh } from '../src/ui/syncLine.js'
import { setLang } from '../src/i18n.js'

const NOW = new Date('2026-10-27T12:00:00Z')
const names = new Map([['d1', 'Telefono 1']])
const st = (o = {}) => ({
  state: 'idle', lastSyncAt: new Date(NOW - 5 * 60000).toISOString(), pending: 0, lastChanges: { count: 0, by: null },
  movedOrphans: 0, errorCode: null, deviceNames: names, family: null, ...o,
})

describe('syncLineText', () => {
  beforeEach(() => setLang('en'))
  afterEach(() => setLang('it'))

  it('idle: relative time, with the changes brought by another device', () => {
    expect(syncLineText(st(), NOW, names)).toBe('Updated 5 min ago')
    expect(syncLineText(st({ lastSyncAt: NOW.toISOString() }), NOW, names)).toBe('Updated just now')
    expect(syncLineText(st({ lastChanges: { count: 3, by: 'd1' } }), NOW, names)).toBe('Updated 5 min ago · 3 changes from Telefono 1')
    expect(syncLineText(st({ lastChanges: { count: 1, by: 'd1' } }), NOW, names)).toBe('Updated 5 min ago · 1 change from Telefono 1')
  })
  it('idle before the first sync shows nothing', () => {
    expect(syncLineText(st({ lastSyncAt: null }), NOW, names)).toBe('')
  })
  it('syncing, offline, removed', () => {
    expect(syncLineText(st({ state: 'syncing' }), NOW, names)).toBe('Syncing…')
    expect(syncLineText(st({ state: 'offline', pending: 2 }), NOW, names)).toBe('Offline · 2 changes to send')
    expect(syncLineText(st({ state: 'removed' }), NOW, names)).toBe('This phone is no longer in the family')
  })
  it('moved orphan items are appended', () => {
    expect(syncLineText(st({ movedOrphans: 2 }), NOW, names)).toContain('2 items moved to Tab')
    expect(syncLineText(st({ movedOrphans: 1 }), NOW, names)).toContain('1 item moved to Tab')
  })
  it('Italian copy and day wording', () => {
    setLang('it')
    expect(syncLineText(st({ lastChanges: { count: 3, by: 'd1' } }), NOW, names)).toBe('Aggiornato 5 min fa · 3 modifiche da Telefono 1')
    expect(syncLineText(st({ lastSyncAt: new Date(NOW - 86400000).toISOString() }), NOW, names)).toBe('Aggiornato ieri')
    expect(syncLineText(st({ state: 'offline', pending: 1 }), NOW, names)).toBe('Offline · 1 modifica da inviare')
    expect(syncLineText(st({ movedOrphans: 2 }), NOW, names)).toContain('2 capi spostati in Scheda')
  })
})

describe('renderSyncLine', () => {
  it('is empty when the device is not in a family', () => {
    enableSyncLine(false)
    expect(renderSyncLine()).toBe('')
  })
})

describe('initPullToRefresh', () => {
  const touch = (el, type, y) => {
    const e = new Event(type, { bubbles: true })
    e.touches = type === 'touchend' ? [] : [{ clientY: y }]
    e.changedTouches = [{ clientY: y }]
    el.dispatchEvent(e)
  }
  it('fires past 70 px from the top only', () => {
    const el = document.createElement('div')
    const fn = vi.fn()
    initPullToRefresh(el, fn)
    el.scrollTop = 0
    touch(el, 'touchstart', 100); touch(el, 'touchmove', 150); touch(el, 'touchend', 150)
    expect(fn).not.toHaveBeenCalled()
    touch(el, 'touchstart', 100); touch(el, 'touchmove', 180); touch(el, 'touchend', 180)
    expect(fn).toHaveBeenCalledTimes(1)
    el.scrollTop = 40
    touch(el, 'touchstart', 100); touch(el, 'touchmove', 200); touch(el, 'touchend', 200)
    expect(fn).toHaveBeenCalledTimes(1)
  })
})
