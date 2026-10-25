// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { renderApp } from '../src/ui/render.js'

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
