// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderApp, hooks } from '../src/ui/render.js'
import { store } from '../src/store.js'

const tab = (id) => ({ id, name: id, order: 0, createdAt: '', updatedAt: '' })
const fire = (el, type) => el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }))

let root, chip
beforeEach(() => {
  vi.useFakeTimers()
  root = document.createElement('div')
  document.body.append(root)
  const s = { tabs: [tab('A'), tab('B')], items: [], currentTabId: 'A', selected: new Set(), unsaved: 0 }
  renderApp(root, s)
  chip = root.querySelector('[data-tab="B"]')
})
afterEach(() => { vi.useRealTimers(); root.remove() })

describe('chip long-press', () => {
  it('fires once after 450 ms, release lands outside root, next click works', () => {
    const lp = vi.fn(), pick = vi.fn()
    hooks.onTabLongPress = lp
    root.addEventListener('click', (e) => { if (e.target.closest('[data-tab]')) pick() })
    fire(chip, 'pointerdown')
    vi.advanceTimersByTime(449)
    expect(lp).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(lp).toHaveBeenCalledTimes(1)
    fire(document.body, 'pointerup') // a modal opened: release is not on root
    fire(document.body, 'click')
    vi.advanceTimersByTime(1)
    expect(lp).toHaveBeenCalledTimes(1)
    chip.click() // normal tap afterwards must not be swallowed
    expect(pick).toHaveBeenCalledTimes(1)
  })

  it('click right after a long-press release on the chip is swallowed', () => {
    hooks.onTabLongPress = vi.fn()
    fire(chip, 'pointerdown')
    vi.advanceTimersByTime(450)
    fire(chip, 'pointerup')
    chip.click()
    expect(chip.classList.contains('on')).toBe(false) // setCurrentTab not triggered
  })

  it('a short tap does not fire the long-press', () => {
    const lp = vi.fn()
    hooks.onTabLongPress = lp
    fire(chip, 'pointerdown')
    vi.advanceTimersByTime(100)
    fire(chip, 'pointerup')
    vi.advanceTimersByTime(1000)
    expect(lp).not.toHaveBeenCalled()
  })
})

describe('tile long-press', () => {
  it('opens the viewer with the section ids after 450 ms and swallows the click (no select)', () => {
    const items = ['a', 'b', 'c'].map((id, n) => ({ id, tabId: 'A', location: n < 2 ? 'school' : 'home', label: id, photoId: 'p' + id }))
    const s = { tabs: [tab('A')], items, currentTabId: 'A', selected: new Set(), unsaved: 0 }
    renderApp(root, s)
    const open = vi.fn()
    hooks.onOpenViewer = open
    const tileB = root.querySelector('.item[data-id="b"]')
    fire(tileB, 'pointerdown')
    vi.advanceTimersByTime(450)
    expect(open).toHaveBeenCalledWith(['a', 'b'], 'b')
    fire(tileB, 'pointerup')
    tileB.click()
    expect(store.selected.size).toBe(0) // click delegation toggles the global store
    tileB.click() // a later plain tap still selects
    expect(store.selected.has('b')).toBe(true)
    store.selected.clear()
  })
})
