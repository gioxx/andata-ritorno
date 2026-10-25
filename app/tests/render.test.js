// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderApp, hooks } from '../src/ui/render.js'
import { store } from '../src/store.js'

const tab = { id: 'A', name: 'A', order: 0, createdAt: '', updatedAt: '' }

describe('render safety net', () => {
  it('a non-string label renders as text instead of crashing', () => {
    const root = document.createElement('div')
    const item = { id: 'i1', tabId: 'A', location: 'school', label: 42, photoId: 'p1' }
    renderApp(root, { tabs: [tab], items: [item], currentTabId: 'A', selected: new Set(), unsaved: 0 })
    const tile = root.querySelector('.item[data-id="i1"]')
    expect(tile.classList.contains('labeled')).toBe(true)
    expect(tile.querySelector('span').textContent).toBe('42')
  })
})

describe('open-photo button on selected tiles', () => {
  const savedHook = hooks.onOpenViewer
  afterEach(() => { store.selected.clear(); hooks.onOpenViewer = savedHook })
  it('opens the viewer on the selected ids in display order without changing the selection', () => {
    const root = document.createElement('div')
    const mk = (id, location) => ({ id, tabId: 'A', location, label: id, photoId: 'p' + id })
    // home item listed first in the store, yet the school section renders first
    const items = [mk('h1', 'home'), mk('s1', 'school'), mk('s2', 'school')]
    const selected = store.selected // tiles read the global store
    selected.clear(); selected.add('h1'); selected.add('s2')
    renderApp(root, { tabs: [tab], items, currentTabId: 'A', selected, unsaved: 0 })
    expect(root.querySelectorAll('.item .open')).toHaveLength(2)
    expect(root.querySelector('.item[data-id="s1"] .open')).toBeNull()
    const open = vi.fn()
    hooks.onOpenViewer = open
    root.querySelector('.item[data-id="h1"] .open').click()
    expect(open).toHaveBeenCalledWith(['s2', 'h1'], 'h1')
    expect([...selected]).toEqual(['h1', 's2'])
  })
})

describe('tag row', () => {
  const cats = [{ id: 'c1', name: 'Maglie', order: 0 }, { id: 'c2', name: 'Pantaloni', order: 1 }]
  const mk = (id, category) => ({ id, tabId: 'A', location: 'school', label: id, photoId: 'p' + id, ...(category ? { category } : {}) })
  const state = (items, filter = new Set(), showTags = true) => ({ tabs: [tab], items, categories: cats, filter, showTags, currentTabId: 'A', selected: new Set(), unsaved: 0 })

  it('the show/hide button appears only when the tab has categorised items', () => {
    const root = document.createElement('div')
    renderApp(root, state([mk('x')], new Set(), false))
    expect(root.querySelector('[data-act="toggleTags"]')).toBeNull()
    renderApp(root, state([mk('x', 'c1')], new Set(), false))
    const btn = root.querySelector('[data-act="toggleTags"]')
    expect(btn.getAttribute('aria-pressed')).toBe('false')
    expect(root.querySelector('.tags')).toBeNull()
    renderApp(root, state([mk('x', 'c1')], new Set(), true))
    expect(root.querySelector('[data-act="toggleTags"]').getAttribute('aria-pressed')).toBe('true')
    expect(root.querySelector('.tags')).not.toBeNull()
  })

  it('is absent when no item of the tab has a category', () => {
    const root = document.createElement('div')
    renderApp(root, state([mk('x')]))
    expect(root.querySelector('.tags')).toBeNull()
  })

  it('lists only the used categories, filters the grid and shows "Tutti ✕" first', () => {
    const root = document.createElement('div')
    const items = [mk('x', 'c1'), mk('y'), mk('z', 'c1')]
    renderApp(root, state(items))
    expect([...root.querySelectorAll('.tags .chip')].map((b) => b.textContent)).toEqual(['Maglie', 'Senza categoria'])
    expect(root.querySelectorAll('.item')).toHaveLength(3)
    renderApp(root, state(items, new Set(['c1'])))
    const pills = [...root.querySelectorAll('.tags .chip')]
    expect(pills[0].textContent).toBe('Tutti ✕')
    expect(pills[1].classList.contains('on')).toBe(true)
    expect(root.querySelectorAll('.item')).toHaveLength(2)
    expect(root.querySelector('.count').textContent).toBe('2')
  })

  it('"Senza categoria" comes last, only when the tab mixes categorised and uncategorised items', () => {
    const root = document.createElement('div')
    renderApp(root, state([mk('x', 'c1'), mk('y', 'c1')]))
    expect(root.querySelector('.tags .none')).toBeNull()
    renderApp(root, state([mk('x', 'c1'), mk('y')]))
    const pills = [...root.querySelectorAll('.tags .chip')]
    expect(pills.at(-1).classList.contains('none')).toBe(true)
    expect(pills.at(-1).textContent).toBe('Senza categoria')
    renderApp(root, state([mk('x', 'c1'), mk('y')], new Set([''])))
    expect([...root.querySelectorAll('.item')].map((n) => n.dataset.id)).toEqual(['y'])
    expect(root.querySelector('.tags .none').getAttribute('aria-pressed')).toBe('true')
  })

  it('tapping "Senza categoria" toggles the uncategorised filter', async () => {
    const { store: st } = await import('../src/store.js')
    Object.assign(st, { tabs: [tab], items: [mk('x', 'c1'), mk('y')], categories: cats, currentTabId: 'A', showTags: true })
    st.filter.clear(); st.selected.clear()
    const root = document.createElement('div')
    renderApp(root, st)
    root.querySelector('.tags .none').click()
    expect([...st.filter]).toEqual([''])
    st.filter.clear()
  })

  it('tapping a pill toggles the store filter; "Tutti ✕" clears it', async () => {
    const { store: st } = await import('../src/store.js')
    Object.assign(st, { tabs: [tab], items: [mk('x', 'c1')], categories: cats, currentTabId: 'A', showTags: true })
    st.filter.clear(); st.selected.clear()
    const root = document.createElement('div')
    renderApp(root, st)
    root.querySelector('[data-tag="c1"]').click()
    expect([...st.filter]).toEqual(['c1'])
    renderApp(root, st)
    root.querySelector('[data-tagclear]').click()
    expect(st.filter.size).toBe(0)
  })
})

describe('categorize button', () => {
  const cats = [{ id: 'c1', name: 'Maglie', order: 0 }]
  const mk = (id) => ({ id, tabId: 'A', location: 'school', label: id, photoId: 'p' + id })
  const draw = (sel, categories) => {
    const root = document.createElement('div')
    renderApp(root, { tabs: [tab], items: [mk('x'), mk('y')], categories, filter: new Set(), currentTabId: 'A', selected: new Set(sel), unsaved: 0 })
    return root
  }
  it('shows with two or more selected items when categories exist', () => {
    expect(draw(['x', 'y'], cats).querySelector('[data-act="categorize"]')).not.toBeNull()
  })
  it('stays hidden with one item (the pencil covers it) or without categories', () => {
    expect(draw(['x'], cats).querySelector('[data-act="categorize"]')).toBeNull()
    expect(draw(['x', 'y'], []).querySelector('[data-act="categorize"]')).toBeNull()
  })
})

describe('category row preference', () => {
  it('is remembered in this browser and read back by load()', async () => {
    const { store: st, setShowTags, load } = await import('../src/store.js')
    const { openDb } = await import('../src/db.js')
    setShowTags(true)
    expect(localStorage.getItem('ar-tags')).toBe('1')
    await load(await openDb('ar-pref-' + crypto.randomUUID()))
    expect(st.showTags).toBe(true)
    setShowTags(false)
    expect(localStorage.getItem('ar-tags')).toBeNull()
    await load(await openDb('ar-pref-' + crypto.randomUUID()))
    expect(st.showTags).toBe(false)
  })
})
