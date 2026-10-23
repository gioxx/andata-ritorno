// Main screen. Whole-screen innerHTML re-render on every store change (small data set),
// one delegated click handler, photos filled in afterwards from cached object URLs.
import { getPhoto } from '../db.js'
import { store, setCurrentTab, selectToggle, selectSection, clearSelection, move, deleteSelected } from '../store.js'
import { menuIcon, trashIcon, checkIcon } from './icons.js'
import { canShowPaste } from './clipboard.js'

/** Later tasks assign their actions here. */
export const hooks = {
  onAddTab() {}, onAdd() {}, onPaste() {}, onMenu() {}, onExport() {},
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
  return `<div class="item${sel ? ' selected' : ''}${moved ? ' moved' : ''}" data-id="${esc(i.id)}">
    <img data-photo="${esc(i.photoId)}" alt=""><span>${esc(i.label || '')}</span>${sel ? `<i class="check">${checkIcon}</i>` : ''}</div>`
}

function section(loc, title, cls, list) {
  return `<section class="${cls}"><h2><span>${title}</span><button class="count" data-section="${loc}" aria-label="Seleziona tutti: ${list.length}">${list.length}</button></h2>
    <div class="grid">${list.length
      ? list.map((i) => tile(i, lastLocation.has(i.id) && lastLocation.get(i.id) !== i.location)).join('')
      : '<div class="empty">Nessun capo</div>'}</div></section>`
}

function bar(sel) {
  if (!sel.length) {
    return `<button class="primary" data-act="add">📷 Aggiungi capi</button>${canShowPaste() ? '<button class="ghost" data-act="paste">📋 Incolla</button>' : ''}`
  }
  const allSchool = sel.every((i) => i.location === 'school')
  const allHome = sel.every((i) => i.location === 'home')
  return `<button class="ghost" data-act="clear">Annulla (${sel.length})</button>
    ${allSchool ? '' : '<button class="primary" data-act="toSchool">→ Scuola</button>'}
    ${allHome ? '' : '<button class="primary" data-act="toHome">→ Casa</button>'}
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
  root.addEventListener('click', (e) => {
    const t = e.target.closest('[data-tab],[data-id],[data-section],[data-act]')
    if (!t) return
    if (t.dataset.tab) return setCurrentTab(t.dataset.tab)
    if (t.dataset.section) return selectSection(t.dataset.section)
    if (t.dataset.id) return selectToggle(t.dataset.id)
    switch (t.dataset.act) {
      case 'addTab': return hooks.onAddTab()
      case 'add': return hooks.onAdd()
      case 'paste': return hooks.onPaste()
      case 'menu': return hooks.onMenu()
      case 'export': return hooks.onExport()
      case 'clear': return clearSelection()
      case 'toSchool': return move('school')
      case 'toHome': return move('home')
      case 'del': if (confirm('Eliminare i capi selezionati?')) return deleteSelected()
    }
  })
}
