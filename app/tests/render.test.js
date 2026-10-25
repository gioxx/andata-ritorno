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
