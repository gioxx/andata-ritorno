// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'

vi.mock('../src/db.js', async (orig) => ({ ...(await orig()), getPhoto: vi.fn(async () => new Blob(['x'], { type: 'image/webp' })) }))
vi.mock('../src/store.js', async (orig) => ({ ...(await orig()), rotateAndEdit: vi.fn(async () => null) }))

const { renderApp } = await import('../src/ui/render.js')
const { store, rotateAndEdit } = await import('../src/store.js')
const { openEditItem, openModal } = await import('../src/ui/dialogs.js')
const { openViewer } = await import('../src/ui/viewer.js')
const { errorMessage } = await import('../src/ui/model.js')
const { t } = await import('../src/i18n.js')

beforeAll(() => {
  // jsdom has no <dialog> modality: model show/close/Escape closely enough for the helper.
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
  HTMLDialogElement.prototype.close = function (rv) {
    if (!this.open) return
    if (rv !== undefined) this.returnValue = rv
    this.removeAttribute('open')
    this.dispatchEvent(new Event('close'))
  }
  URL.createObjectURL = () => 'blob:x'
  URL.revokeObjectURL = () => {}
})

const tab = { id: 'A', name: 'Casa', order: 0 }
const cats = [{ id: 'c1', name: 'Maglie', order: 0 }]
const mk = (id, extra = {}) => ({ id, tabId: 'A', location: 'school', label: 'Maglia ' + id, photoId: 'p' + id, ...extra })
const setStore = (items) => {
  Object.assign(store, { tabs: [tab], items, categories: cats, currentTabId: 'A', unsaved: 0 })
  store.selected.clear(); store.filter.clear()
}
const mount = () => { const root = document.createElement('div'); document.body.append(root); return root }
const key = (target, k) => target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))

// The viewer is a build-once singleton: keep its element, drop everything else.
afterEach(() => { for (const n of [...document.body.children]) if (n.id !== 'viewer') n.remove(); vi.restoreAllMocks() })

describe('tiles', () => {
  it('are toggle buttons: aria-pressed flips on click and the label says what/where/category', () => {
    setStore([mk('a', { category: 'c1' }), mk('b', { location: 'home' })])
    const root = mount()
    renderApp(root, store)
    const pick = (id) => root.querySelector(`.item[data-id="${id}"] .pick`)
    expect(pick('a').tagName).toBe('BUTTON')
    expect(pick('a').getAttribute('aria-pressed')).toBe('false')
    expect(pick('a').getAttribute('aria-label')).toBe('Maglia a, A scuola, Maglie')
    expect(pick('b').getAttribute('aria-label')).toBe('Maglia b, A casa, senza categoria')
    pick('a').click()
    expect(store.selected.has('a')).toBe(true)
    renderApp(root, store)
    expect(pick('a').getAttribute('aria-pressed')).toBe('true')
    // two sibling buttons, never nested
    const open = root.querySelector('.item[data-id="a"] .open')
    expect(open.parentElement).toBe(pick('a').parentElement)
    expect(pick('a').contains(open)).toBe(false)
  })

  it('keeps keyboard focus on the tile across the redraw that follows a toggle', () => {
    setStore([mk('a')])
    const root = mount()
    renderApp(root, store)
    root.querySelector('.pick').focus()
    root.querySelector('.pick').click()
    renderApp(root, store)
    expect(document.activeElement).toBe(root.querySelector('.item[data-id="a"] .pick'))
  })
})

describe('dialogs', () => {
  it('edit dialog takes focus and gives it back to the opener on close (Escape)', () => {
    setStore([mk('a')])
    const opener = Object.assign(document.createElement('button'), { textContent: 'edit' })
    document.body.append(opener)
    opener.focus()
    openEditItem('a')
    const dlg = document.getElementById('editItem')
    expect(dlg.open).toBe(true)
    expect(dlg.contains(document.activeElement)).toBe(true)
    expect(dlg.getAttribute('aria-labelledby')).toBeTruthy()
    key(dlg, 'Escape')
    expect(dlg.open).toBe(false)
    expect(document.activeElement).toBe(opener)
  })

  it('a dialog opened as another closes takes its opener, so focus lands back on the control', () => {
    const opener = document.body.appendChild(document.createElement('button'))
    const mkDlg = () => document.body.appendChild(Object.assign(document.createElement('dialog'), { innerHTML: '<h3>x</h3><button>ok</button>' }))
    const a = mkDlg(), b = mkDlg()
    opener.focus()
    openModal(a)
    a.close() // the drawer closes, then opens the next dialog right away
    openModal(b)
    a.dispatchEvent(new Event('close')) // late: must not steal focus (close() above already dispatched in this model)
    expect(b.contains(document.activeElement)).toBe(true)
    b.close()
    expect(document.activeElement).toBe(opener)
  })
})

describe('viewer', () => {
  const opener = () => { const b = document.body.appendChild(document.createElement('button')); b.focus(); return b }
  beforeEach(() => setStore([mk('a'), mk('b'), mk('c')]))
  afterEach(() => { key(document, 'Escape') })

  it('Escape closes it and focus returns to the opener', () => {
    const o = opener()
    openViewer(['a', 'b'], 'a')
    const v = document.getElementById('viewer')
    expect(v.hidden).toBe(false)
    expect(v.contains(document.activeElement)).toBe(true)
    key(document, 'Escape')
    expect(v.hidden).toBe(true)
    expect(document.activeElement).toBe(o)
  })

  it('has Previous / Next buttons for several items, working with the arrow keys too', () => {
    opener()
    openViewer(['a', 'b', 'c'], 'a')
    const v = document.getElementById('viewer')
    const label = () => v.querySelector('.vlabel').textContent
    const prev = v.querySelector('[data-v="prev"]'), next = v.querySelector('[data-v="next"]')
    expect(prev.hidden).toBe(false)
    expect(prev.disabled).toBe(true)
    expect(label()).toBe('Maglia a')
    next.click()
    expect(label()).toBe('Maglia b')
    expect(v.querySelector('[data-live="pos"]').textContent).toBe('Maglia b, 2 di 3')
    key(document, 'ArrowRight')
    expect(label()).toBe('Maglia c')
    expect(next.disabled).toBe(true)
    key(document, 'ArrowLeft')
    expect(label()).toBe('Maglia b')
  })

  it('hides the navigation for a single item', () => {
    opener()
    openViewer(['a'], 'a')
    expect(document.querySelector('#viewer [data-v="next"]').hidden).toBe(true)
  })

  it('announces a pending rotation; Salva goes through the store and keeps the rotation on a missing source', async () => {
    opener()
    openViewer(['a', 'b'], 'a')
    const v = document.getElementById('viewer')
    v.querySelector('[data-v="rotate"]').click()
    expect(v.querySelector('[aria-live="polite"][data-live="state"]').textContent).toBe(t('viewer.pending'))
    expect(v.querySelector('[data-v="next"]').disabled).toBe(true)
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {})
    rotateAndEdit.mockResolvedValueOnce(new Error('rotate-missing'))
    v.querySelector('[data-v="save"]').click()
    await vi.waitFor(() => expect(alert).toHaveBeenCalledWith(t('rotate.missingPhoto')))
    expect(rotateAndEdit).toHaveBeenCalledWith('a', {}, 1)
    expect(v.classList.contains('pending')).toBe(true) // still pending: retry or cancel
    rotateAndEdit.mockResolvedValueOnce(null)
    v.querySelector('[data-v="save"]').click()
    await vi.waitFor(() => expect(v.classList.contains('pending')).toBe(false))
    expect(v.querySelector('[data-live="state"]').textContent).toBe('')
  })
})

describe('error mapping', () => {
  it('a rotation whose source photo is gone reads as the "missing photo" message', () => {
    expect(errorMessage(new Error('rotate-missing'), store)).toBe('La foto originale non si trova: riprova.')
  })
})
