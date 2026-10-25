// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { openCategoryManager } from '../src/ui/categories.js'
import { store } from '../src/store.js'

HTMLDialogElement.prototype.showModal = function () { this.open = true }

describe('category manager', () => {
  it('shows how many items use each category, across every tab', () => {
    const tabs = [{ id: 'A', name: 'A', order: 0 }, { id: 'B', name: 'B', order: 1 }]
    const mk = (id, tabId, category) => ({ id, tabId, location: 'school', label: '', photoId: 'p' + id, ...(category ? { category } : {}) })
    const items = [mk('1', 'A', 'c1'), mk('2', 'B', 'c1'), mk('3', 'A', 'c2'), mk('4', 'A')]
    const categories = [{ id: 'c1', name: 'Maglie', order: 0 }, { id: 'c2', name: 'Calze', order: 1 }, { id: 'c3', name: 'Body', order: 2 }]
    Object.assign(store, { tabs, items, categories, currentTabId: 'A' })
    openCategoryManager()
    const counts = [...document.querySelectorAll('#catList .catcount')].map((n) => n.textContent)
    expect(counts).toEqual(['2', '1', '0'])
    const labels = [...document.querySelectorAll('#catList input')].map((n) => n.getAttribute('aria-label'))
    expect(labels).toEqual(['Nome categoria, 2 capi', 'Nome categoria, 1 capo', 'Nome categoria, 0 capi'])
  })
})
