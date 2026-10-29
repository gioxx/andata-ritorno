// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { syncLineText, renderSyncLine, enableSyncLine, initPullToRefresh, syncProgress, progressText, paintSyncLine, patchSyncLine } from '../src/ui/syncLine.js'
import { setLang } from '../src/i18n.js'
import { store } from '../src/store.js'
import { syncStatus } from '../src/sync/engine.js'
import { familyError } from '../src/ui/familyMenu.js'

const NOW = new Date('2026-10-27T12:00:00Z')
const names = new Map([['d1', 'Telefono 1']])
const st = (o = {}) => ({
  state: 'idle', lastSyncAt: new Date(NOW - 5 * 60000).toISOString(), pending: 0, lastChanges: { count: 0, by: null },
  movedOrphans: 0, movedOrphansTab: null, errorCode: null, deviceNames: names, family: null, ...o,
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
  it('enableSyncLine toggles the in-family class on <html>', () => {
    enableSyncLine(true)
    expect(document.documentElement.classList.contains('in-family')).toBe(true)
    enableSyncLine(false)
    expect(document.documentElement.classList.contains('in-family')).toBe(false)
  })
  it('syncing, offline, removed', () => {
    expect(syncLineText(st({ state: 'syncing' }), NOW, names)).toBe('Syncing…')
    expect(syncLineText(st({ state: 'offline', pending: 2 }), NOW, names)).toBe('Offline · 2 changes to send')
    expect(syncLineText(st({ state: 'removed' }), NOW, names)).toBe('This phone is no longer in the family')
  })
  it('offline with nothing waiting is plain Offline', () => {
    expect(syncLineText(st({ state: 'offline', pending: 0 }), NOW, names)).toBe('Offline')
  })
  it('error: the message for its code, with the changes still to send; before the first sync too', () => {
    const msg = familyError('limit-photo-size')
    expect(syncLineText(st({ state: 'error', errorCode: 'limit-photo-size' }), NOW, names)).toBe(msg)
    expect(syncLineText(st({ state: 'error', errorCode: 'limit-photo-size', pending: 2 }), NOW, names)).toBe(`${msg} · 2 changes to send`)
    expect(syncLineText(st({ state: 'error', errorCode: 'rate-limited', lastSyncAt: null }), NOW, names)).toBe(familyError('rate-limited'))
    expect(syncLineText(st({ state: 'error', errorCode: null, lastSyncAt: null }), NOW, names)).toBe(familyError('internal'))
  })
  it('moved orphan items are appended', () => {
    expect(syncLineText(st({ movedOrphans: 2, movedOrphansTab: 'Scuola' }), NOW, names)).toContain('2 items moved to Scuola')
    expect(syncLineText(st({ movedOrphans: 1, movedOrphansTab: 'Scuola' }), NOW, names)).toContain('1 item moved to Scuola')
  })
  it('Italian copy and day wording', () => {
    setLang('it')
    expect(syncLineText(st({ lastChanges: { count: 3, by: 'd1' } }), NOW, names)).toBe('Aggiornato 5 min fa · 3 modifiche da Telefono 1')
    expect(syncLineText(st({ lastSyncAt: new Date(NOW - 86400000).toISOString() }), NOW, names)).toBe('Aggiornato ieri')
    expect(syncLineText(st({ state: 'offline', pending: 1 }), NOW, names)).toBe('Offline · 1 modifica da inviare')
    expect(syncLineText(st({ movedOrphans: 2, movedOrphansTab: 'Scuola' }), NOW, names)).toContain('2 capi spostati in Scuola')
  })
})

describe('renderSyncLine', () => {
  it('is empty when the device is not in a family', () => {
    enableSyncLine(false)
    expect(renderSyncLine()).toBe('')
  })
  it('an error before the first sync is shown, not "Syncing…" forever', () => {
    const saved = { ...syncStatus }
    Object.assign(syncStatus, { state: 'error', errorCode: 'bad-code', lastSyncAt: null, pending: 0 })
    enableSyncLine(true)
    try {
      expect(renderSyncLine()).toContain(familyError('bad-code'))
    } finally {
      enableSyncLine(false)
      Object.assign(syncStatus, saved)
    }
  })
})

describe('progress bar', () => {
  let saved
  beforeEach(() => { saved = { ...syncStatus }; document.body.innerHTML = '' })
  afterEach(() => { enableSyncLine(false); Object.assign(syncStatus, saved); setLang('it'); document.body.innerHTML = '' })
  const draw = () => {
    const root = document.createElement('div')
    root.innerHTML = renderSyncLine()
    document.body.append(root)
    paintSyncLine(root)
    return root
  }

  it('phase texts in both languages', () => {
    const p = (phase, done, total) => progressText({ phase, done, total })
    setLang('it')
    expect(p('upload-photos', 2, 5)).toBe('Invio foto 2 di 5')
    expect(p('push', 200, 201)).toBe('Invio modifiche 200 di 201')
    expect(p('pull', 3, 9)).toBe('Ricezione modifiche 3 di 9')
    expect(p('pull', 4, null)).toBe('Ricezione modifiche…')
    expect(p('download-photos', 1, 3)).toBe('Foto 1 di 3')
    setLang('en')
    expect(p('upload-photos', 2, 5)).toBe('Sending photos 2 of 5')
    expect(p('push', 200, 201)).toBe('Sending changes 200 of 201')
    expect(p('pull', 3, 9)).toBe('Receiving changes 3 of 9')
    expect(p('pull', 4, null)).toBe('Receiving changes…')
    expect(p('download-photos', 1, 3)).toBe('Photos 1 of 3')
  })

  it('the run wins over the background photo counter; nothing when neither', () => {
    expect(syncProgress({ progress: null, photoDownloads: null })).toBeNull()
    expect(syncProgress({ progress: null, photoDownloads: { done: 1, total: 3 } })).toEqual({ phase: 'download-photos', done: 1, total: 3 })
    expect(syncProgress({ progress: { phase: 'push', done: 0, total: 4 }, photoDownloads: { done: 1, total: 3 } })).toEqual({ phase: 'push', done: 0, total: 4 })
  })

  it('determinate: a progressbar with its values and width, the phase text under it', () => {
    Object.assign(syncStatus, { state: 'syncing', progress: { phase: 'upload-photos', done: 1, total: 4 }, photoDownloads: null })
    enableSyncLine(true)
    const root = draw()
    const bar = root.querySelector('[role="progressbar"]')
    expect(bar.getAttribute('aria-valuemin')).toBe('0')
    expect(bar.getAttribute('aria-valuemax')).toBe('4')
    expect(bar.getAttribute('aria-valuenow')).toBe('1')
    expect(bar.classList.contains('indeterminate')).toBe(false)
    expect(bar.firstElementChild.style.width).toBe('25%')
    expect(root.querySelector('.syncphase').textContent).toBe('Invio foto 1 di 4')
    expect(root.querySelector('.syncbar').getAttribute('aria-busy')).toBe('true')
  })

  it('indeterminate: no values, the animated class', () => {
    Object.assign(syncStatus, { state: 'syncing', progress: { phase: 'pull', done: 0, total: null }, photoDownloads: null })
    enableSyncLine(true)
    const bar = draw().querySelector('[role="progressbar"]')
    expect(bar.classList.contains('indeterminate')).toBe(true)
    expect(bar.hasAttribute('aria-valuenow')).toBe(false)
    expect(bar.hasAttribute('aria-valuemax')).toBe(false)
  })

  it('no bar when idle, and nothing at all outside a family', () => {
    Object.assign(syncStatus, { state: 'idle', lastSyncAt: new Date().toISOString(), progress: null, photoDownloads: null })
    enableSyncLine(true)
    const root = draw()
    expect(root.querySelector('.syncline')).not.toBeNull()
    expect(root.querySelector('[role="progressbar"]')).toBeNull()
    expect(root.querySelector('.syncbar').getAttribute('aria-busy')).toBe('false')
    enableSyncLine(false)
    Object.assign(syncStatus, { progress: { phase: 'push', done: 1, total: 2 } })
    expect(renderSyncLine()).toBe('')
  })

  it('a patch moves the bar in place and announces phase changes only', () => {
    Object.assign(syncStatus, { state: 'syncing', progress: { phase: 'upload-photos', done: 0, total: 3 }, photoDownloads: null })
    enableSyncLine(true)
    const root = draw()
    const live = document.querySelector('[aria-live="polite"]')
    const button = root.querySelector('.syncline')
    expect(live.textContent).toBe('Invio foto 0 di 3')
    Object.assign(syncStatus, { progress: { phase: 'upload-photos', done: 2, total: 3 } })
    patchSyncLine(root)
    expect(root.querySelector('.syncline')).toBe(button) // the button (and its focus) survives
    expect(root.querySelector('[role="progressbar"]').getAttribute('aria-valuenow')).toBe('2')
    expect(root.querySelector('.syncphase').textContent).toBe('Invio foto 2 di 3')
    expect(live.textContent).toBe('Invio foto 0 di 3') // same phase: not announced again
    Object.assign(syncStatus, { progress: { phase: 'push', done: 0, total: 5 } })
    patchSyncLine(root)
    expect(live.textContent).toBe('Invio modifiche 0 di 5')
    Object.assign(syncStatus, { state: 'idle', progress: null })
    patchSyncLine(root)
    expect(root.querySelector('[role="progressbar"]')).toBeNull()
    expect(root.querySelector('.syncbar').getAttribute('aria-busy')).toBe('false')
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

  describe('ignored gestures', () => {
    const pull = (el, x2 = 100) => {
      const at = (type, x, y) => { const e = new Event(type, { bubbles: true }); e.touches = type === 'touchend' ? [] : [{ clientX: x, clientY: y }]; el.dispatchEvent(e) }
      at('touchstart', 100, 100); at('touchmove', x2, 200); at('touchend', x2, 200)
    }
    const setup = () => {
      const fn = vi.fn()
      initPullToRefresh(document.documentElement, fn)
      return fn
    }
    afterEach(() => { document.body.innerHTML = ''; store.selected.clear() })

    it('ignores a mostly horizontal drag', () => {
      const fn = setup()
      pull(document.body, 300)
      expect(fn).not.toHaveBeenCalled()
      pull(document.body, 110)
      expect(fn).toHaveBeenCalledTimes(1)
    })
    it('ignores touches inside the viewer or a dialog, and while an overlay is open', () => {
      const fn = setup()
      document.body.innerHTML = '<div id="viewer"><i id="in"></i></div><dialog id="d" open><i id="din"></i></dialog><p id="out"></p>'
      pull(document.getElementById('in'))
      pull(document.getElementById('din'))
      pull(document.getElementById('out')) // the dialog is open
      expect(fn).not.toHaveBeenCalled()
    })
    it('ignores the pull while items are selected', () => {
      const fn = setup()
      store.selected.add('x')
      pull(document.body)
      expect(fn).not.toHaveBeenCalled()
    })
  })
})
