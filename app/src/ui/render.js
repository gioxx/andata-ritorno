// Main screen. Whole-screen innerHTML re-render on every store change (small data set),
// one delegated click handler, photos filled in afterwards from cached object URLs.
import { getPhoto } from '../db.js'
import { store, setCurrentTab, selectToggle, selectSection, clearSelection, move, deleteSelected } from '../store.js'
import { menuIcon, trashIcon, checkIcon, pencilIcon, expandIcon, cameraIcon, pasteIcon } from './icons.js'
import { canShowPaste } from './clipboard.js'
import { reportError } from './dialogs.js'

/** Later tasks assign their actions here. */
export const hooks = {
  onAddTab() {}, onTabLongPress(_id) {}, onImportFile(_file) {}, onAdd() {}, onPaste() {}, onMenu() {}, onExport() {},
  onEdit(_id) {}, onOpenViewer(_ids, _startId) {},
}

export const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]))

/** @type {Map<string,string>} photoId -> object URL */
const urls = new Map()
const pending = new Map()
/** itemId -> location at last render, to animate only tiles that changed section */
let lastLocation = new Map()
const wired = new WeakSet()

function photoUrl(photoId) {
  if (urls.has(photoId)) return Promise.resolve(urls.get(photoId))
  if (!pending.has(photoId)) {
    pending.set(photoId, getPhoto(store.db, photoId).then((blob) => {
      pending.delete(photoId)
      if (!blob || !store.items.some((i) => i.photoId === photoId)) return null // item vanished meanwhile
      const url = URL.createObjectURL(blob)
      urls.set(photoId, url)
      return url
    }, () => { pending.delete(photoId); return null }))
  }
  return pending.get(photoId)
}

function revokeGone() {
  const alive = new Set(store.items.map((i) => i.photoId))
  for (const [id, url] of urls) if (!alive.has(id)) { URL.revokeObjectURL(url); urls.delete(id) }
}

function tile(i, moved) {
  const sel = store.selected.has(i.id)
  return `<div class="item${i.label?.trim() ? ' labeled' : ''}${sel ? ' selected' : ''}${moved ? ' moved' : ''}" data-id="${esc(i.id)}">
    <img data-photo="${esc(i.photoId)}" alt=""><span>${esc(i.label || '')}</span>${sel ? `<i class="check">${checkIcon}</i><button class="expand" data-view="${esc(i.id)}" aria-label="Apri a schermo intero">${expandIcon}</button>` : ''}</div>`
}

function section(loc, title, cls, list) {
  return `<section class="${cls}"><h2><span>${title}</span><button class="count" data-section="${loc}" aria-label="Seleziona tutti: ${list.length}">${list.length}</button></h2>
    <div class="grid">${list.length
      ? list.map((i) => tile(i, lastLocation.has(i.id) && lastLocation.get(i.id) !== i.location)).join('')
      : '<div class="empty">Nessun capo</div>'}</div></section>`
}

function bar(sel) {
  if (!sel.length) {
    return `<button class="primary" data-act="add">${cameraIcon}Aggiungi capi</button>${canShowPaste() ? `<button class="ghost" data-act="paste">${pasteIcon}Incolla</button>` : ''}`
  }
  const allSchool = sel.every((i) => i.location === 'school')
  const allHome = sel.every((i) => i.location === 'home')
  return `<button class="ghost" data-act="clear">Annulla (${sel.length})</button>
    ${allSchool ? '' : '<button class="primary" data-act="toSchool">→ Scuola</button>'}
    ${allHome ? '' : '<button class="primary" data-act="toHome">→ Casa</button>'}
    ${sel.length === 1 ? `<button class="ghost icon" data-act="edit" aria-label="Modifica">${pencilIcon}</button>` : ''}
    <button class="ghost icon" data-act="del" aria-label="Elimina">${trashIcon}</button>`
}

export function renderApp(root, s = store) {
  wire(root)
  const chipsOld = root.querySelector('.chips')
  const chipsScroll = chipsOld ? chipsOld.scrollLeft : 0
  const items = s.items.filter((i) => i.tabId === s.currentTabId)
  const sel = [...s.selected].map((id) => s.items.find((i) => i.id === id)).filter(Boolean)
  const n = s.unsaved
  const banner = n
    ? `<div class="unsaved"><span>⚠ ${n === 1 ? '1 modifica non salvata' : `${n} modifiche non salvate`}</span><button data-act="export">Esporta</button></div>`
    : ''
  root.innerHTML = `<header>
      <div class="row1"><h1>Andata e Ritorno</h1><button class="menu" data-act="menu" aria-label="Menu">${menuIcon}</button></div>
      <nav class="chips">${s.tabs.map((t) => `<button class="chip${t.id === s.currentTabId ? ' on' : ''}" data-tab="${esc(t.id)}">${esc(t.name)}</button>`).join('')}<button class="chip add" data-act="addTab" aria-label="Aggiungi scheda">+</button></nav>
    </header>
    <main>${banner}${section('school', '🏫 A scuola', 'school', items.filter((i) => i.location === 'school'))}${section('home', '🏠 A casa', 'home', items.filter((i) => i.location === 'home'))}</main>
    <footer class="bar">${bar(sel)}</footer>`
  root.querySelector('.chips').scrollLeft = chipsScroll

  lastLocation = new Map(s.items.map((i) => [i.id, i.location]))
  revokeGone()
  for (const img of root.querySelectorAll('img[data-photo]')) {
    photoUrl(img.dataset.photo).then((url) => { if (url && img.isConnected) img.src = url })
  }
}

function wire(root) {
  if (wired.has(root)) return
  wired.add(root)
  wireLongPress(root)
  root.addEventListener('click', (e) => {
    const t = e.target.closest('[data-tab],[data-view],[data-id],[data-section],[data-act]')
    if (!t) return
    if (t.dataset.tab) return setCurrentTab(t.dataset.tab)
    if (t.dataset.view) return act(() => hooks.onOpenViewer(sectionIds(t), t.dataset.view))
    if (t.dataset.section) return selectSection(t.dataset.section)
    if (t.dataset.id) return selectToggle(t.dataset.id)
    switch (t.dataset.act) {
      case 'addTab': return act(hooks.onAddTab)
      case 'add': return act(hooks.onAdd)
      case 'paste': return act(hooks.onPaste)
      case 'menu': return act(hooks.onMenu)
      case 'export': return act(hooks.onExport)
      case 'edit': return act(() => hooks.onEdit([...store.selected][0]))
      case 'clear': return clearSelection()
      case 'toSchool': return act(() => move('school'))
      case 'toHome': return act(() => move('home'))
      case 'del': if (confirm('Eliminare i capi selezionati?')) return act(deleteSelected)
    }
  })
}

const LONG_PRESS_MS = 450

/** Ids of the tiles in the same section as `el`, in display order. */
const sectionIds = (el) => [...el.closest('.grid').querySelectorAll('.item[data-id]')].map((n) => n.dataset.id)

// What a long-press does, per pressable element.
const LONG_PRESS = [
  { sel: '.chip[data-tab]', run: (el) => hooks.onTabLongPress(el.dataset.tab) }, // tab manager
  { sel: '.item[data-id]', run: (el) => hooks.onOpenViewer(sectionIds(el), el.dataset.id) }, // full-screen viewer
]
const pressable = (target) => {
  for (const p of LONG_PRESS) { const el = target.closest(p.sel); if (el) return { el, run: p.run } }
  return null
}

/** Long-press on a tab chip or a tile; the click that follows the release is swallowed. */
function wireLongPress(root) {
  let timer = 0, fired = false, x = 0, y = 0
  const cancel = () => { clearTimeout(timer); timer = 0 }
  root.addEventListener('pointerdown', (e) => {
    const hit = pressable(e.target)
    if (!hit) return
    fired = false; x = e.clientX; y = e.clientY
    cancel()
    timer = setTimeout(() => { fired = true; act(() => hit.run(hit.el)) }, LONG_PRESS_MS)
  })
  root.addEventListener('pointermove', (e) => { if (timer && Math.hypot(e.clientX - x, e.clientY - y) > 10) cancel() })
  // On document: after a long-press a modal opens and the release lands outside root.
  // The click (if any) follows pointerup right away, so `fired` is cleared a tick later.
  for (const ev of ['pointerup', 'pointercancel']) document.addEventListener(ev, () => {
    cancel()
    setTimeout(() => { fired = false }, 0)
  })
  root.addEventListener('pointerleave', cancel)
  // Capture phase: runs before the delegated click handler below.
  root.addEventListener('click', (e) => {
    if (!fired) return
    fired = false
    e.stopImmediatePropagation(); e.preventDefault()
  }, true)
  // Android Chrome shows a context menu on long-press; the manager / viewer replaces it.
  root.addEventListener('contextmenu', (e) => { if (pressable(e.target)) e.preventDefault() })
}

/** Run an action; any failure (sync or async) goes to one user-facing handler. */
function act(fn) {
  try { Promise.resolve(fn()).catch(reportError) } catch (e) { reportError(e) }
}
