// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { renderApp } from '../src/ui/render.js'
import { openEditItem } from '../src/ui/dialogs.js'
import { openCategoryManager } from '../src/ui/categories.js'
import { store } from '../src/store.js'

HTMLDialogElement.prototype.showModal = function () { this.open = true }
const NAME = '<b>"x"</b>'

describe('category names are escaped', () => {
  it('tag row, picker and manager show the text literally', () => {
    const tab = { id: 'A', name: 'A', order: 0 }
    const item = { id: 'i1', tabId: 'A', location: 'school', label: '', photoId: 'p', category: 'c1' }
    Object.assign(store, { tabs: [tab], items: [item], categories: [{ id: 'c1', name: NAME, order: 0 }], currentTabId: 'A' })
    store.filter.clear()

    const root = document.createElement('div')
    renderApp(root, store)
    const pill = root.querySelector('.tags [data-tag]')
    expect(pill.textContent).toBe(NAME)
    expect(pill.querySelector('b')).toBeNull()

    openEditItem('i1')
    const pick = document.getElementById('editCat')
    expect(pick.querySelector('[data-cat="c1"]').textContent).toBe(NAME)
    expect(pick.querySelector('b')).toBeNull()

    openCategoryManager()
    const input = document.querySelector('#catList input')
    expect(input.value).toBe(NAME)
    expect(document.querySelector('#catList b')).toBeNull()
  })
})
