// Main screen. Whole-screen innerHTML re-render on every store change (small data set),
// one delegated click handler, photos filled in afterwards from cached object URLs.
import { getPhoto } from '../db.js'
import { store, setShowTags, setCurrentTab, selectToggle, selectSection, clearSelection, move, deleteSelected, categorizeSelected, toggleFilter, clearFilter } from '../store.js'
import { visibleItems, usableFilters, UNCATEGORISED } from './filter.js'
import { categoryName } from '../categories.js'
import { menuIcon, trashIcon, checkIcon, pencilIcon, zoomInIcon, cameraIcon, pasteIcon, tagIcon, filterIcon } from './icons.js'
import { canShowPaste } from './clipboard.js'
import { reportError, askCategory } from './dialogs.js'
import { t } from '../i18n.js'
import { esc } from './esc.js'
import { keepFocus, noteActivator } from './focus.js'

/** Later tasks assign their actions here. */
export const hooks = {
  onAddTab() {}, onTabLongPress(_id) {}, onImportFile(_file) {}, onAdd() {}, onPaste() {}, onMenu() {}, onExport() {},
  onEdit(_id) {}, onOpenViewer(_ids, _startId) {}, onManageCategories() {},
}

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

/** Spoken name of a tile: description, place and category. */
function tileLabel(i, label, categories) {
  const cat = categories.find((c) => c.id === i.category)
  return t('item.aria', { label: label.trim() || t('common.unnamed'), place: t(i.location === 'home' ? 'loc.home' : 'loc.school'), category: cat ? categoryName(cat) : t('item.noCategory') })
}

// The tile is a wrapper (a button cannot hold another button): `.pick` covers it and carries the
// selection state, `.open` (selected tiles only) is its sibling. Long-press targets the wrapper.
function tile(i, moved, categories) {
  const sel = store.selected.has(i.id)
  const label = String(i.label ?? '') // safety net: never trust the type of stored data
  return `<div class="item${label.trim() ? ' labeled' : ''}${sel ? ' selected' : ''}${moved ? ' moved' : ''}" data-id="${esc(i.id)}">
    <img data-photo="${esc(i.photoId)}" alt=""><span aria-hidden="true">${esc(label)}</span><button type="button" class="pick" aria-pressed="${sel}" aria-label="${esc(tileLabel(i, label, categories))}"></button>${sel ? `<i class="check" aria-hidden="true">${checkIcon}</i><button type="button" class="open" data-view="${esc(i.id)}" aria-label="${t('render.openPhoto')}">${zoomInIcon}</button>` : ''}</div>`
}

function section(loc, title, cls, list, categories) {
  return `<section class="${cls}"><h2><span>${title}</span><button class="count" data-section="${loc}" aria-label="${t('render.selectAll', { n: list.length })}">${list.length}</button></h2>
    <div class="grid">${list.length
      ? list.map((i) => tile(i, lastLocation.has(i.id) && lastLocation.get(i.id) !== i.location, categories)).join('')
      : `<div class="empty">${t('render.empty')}</div>`}</div></section>`
}

/** Pills for the categories used in this tab (category order), then "Senza categoria"; none when nothing is categorised. */
function tagRow(tabItems, s) {
  const used = usableFilters(tabItems)
  const cats = (s.categories ?? []).filter((c) => used.has(c.id))
  if (!cats.length) return ''
  if (!s.showTags) return ''
  const filter = s.filter ?? new Set()
  const pill = (id, label, cls = '') => `<button class="chip tag${cls}${filter.has(id) ? ' on' : ''}" data-tag="${esc(id)}" aria-pressed="${filter.has(id)}">${label}</button>`
  return `<nav class="tags" aria-label="${t('render.tags')}"><span class="tagsicon" aria-hidden="true">${filterIcon}</span>${filter.size ? `<button class="chip tag clear" data-tagclear="1">${t('render.tagsAll')}</button>` : ''}${
    cats.map((c) => pill(c.id, esc(categoryName(c)))).join('')}${used.has(UNCATEGORISED) ? pill(UNCATEGORISED, t('render.tagsNone'), ' none') : ''}</nav>`
}

/** Show/hide button for the category row, only when the tab has something to filter by. */
function tagToggle(tabItems, s) {
  if (!tabItems.some((i) => i.category)) return ''
  return `<button class="menu tagtoggle${s.showTags ? ' on' : ''}" data-act="toggleTags" aria-pressed="${!!s.showTags}" aria-label="${t('render.tagsToggle')}">${filterIcon}</button>`
}

function bar(sel, hasCategories) {
  if (!sel.length) {
    return `<button class="primary" data-act="add">${cameraIcon}${t('render.add')}</button>${canShowPaste() ? `<button class="ghost" data-act="paste">${pasteIcon}${t('render.paste')}</button>` : ''}`
  }
  const allSchool = sel.every((i) => i.location === 'school')
  const allHome = sel.every((i) => i.location === 'home')
  return `<button class="ghost" data-act="clear">${t('render.clear', { n: sel.length })}</button>
    ${allSchool ? '' : `<button class="primary" data-act="toSchool">${t('render.toSchool')}</button>`}
    ${allHome ? '' : `<button class="primary" data-act="toHome">${t('render.toHome')}</button>`}
    ${sel.length === 1 ? `<button class="ghost icon" data-act="edit" aria-label="${t('common.edit')}">${pencilIcon}</button>` : ''}
    ${sel.length > 1 && hasCategories ? `<button class="ghost icon" data-act="categorize" aria-label="${t('render.categorize')}">${tagIcon}</button>` : ''}
    <button class="ghost icon" data-act="del" aria-label="${t('common.delete')}">${trashIcon}</button>`
}

export function renderApp(root, s = store) {
  wire(root)
  const chipsOld = root.querySelector('.chips')
  const chipsScroll = chipsOld ? chipsOld.scrollLeft : 0
  const tagsOld = root.querySelector('.tags')
  const tagsScroll = tagsOld ? tagsOld.scrollLeft : 0
  const tabItems = s.items.filter((i) => i.tabId === s.currentTabId)
  const items = visibleItems(tabItems, s.filter)
  const sel = [...s.selected].map((id) => s.items.find((i) => i.id === id)).filter(Boolean)
  const n = s.unsaved
  const cats = s.categories ?? []
  const banner = n
    ? `<div class="unsaved"><span>⚠ ${t('render.unsaved', { n })}</span><button data-act="export">${t('render.export')}</button></div>`
    : ''
  keepFocus(root, () => { root.innerHTML = `<header>
      <div class="row1"><h1>${t('app.name')}</h1>${tagToggle(tabItems, s)}<button class="menu" data-act="menu" aria-label="${t('render.menu')}">${menuIcon}</button></div>
      <nav class="chips" aria-label="${t('render.tabs')}">${s.tabs.map((tb) => `<button class="chip${tb.id === s.currentTabId ? ' on' : ''}" data-tab="${esc(tb.id)}"${tb.id === s.currentTabId ? ' aria-current="true"' : ''}>${esc(tb.name)}</button>`).join('')}<button class="chip add" data-act="addTab" aria-label="${t('render.addTab')}">+</button></nav>${tagRow(tabItems, s)}
    </header>
    <main>${banner}${section('school', `🏫 ${t('loc.school')}`, 'school', items.filter((i) => i.location === 'school'), cats)}${section('home', `🏠 ${t('loc.home')}`, 'home', items.filter((i) => i.location === 'home'), cats)}</main>
    <footer class="bar">${bar(sel, cats.length > 0)}</footer>` })
  root.querySelector('.chips').scrollLeft = chipsScroll
  const tags = root.querySelector('.tags')
  if (tags) tags.scrollLeft = tagsScroll

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
    const el = e.target.closest('[data-tab],[data-tag],[data-tagclear],[data-view],[data-id],[data-section],[data-act]')
    if (!el) return
    noteActivator(el)
    if (el.dataset.tab) return setCurrentTab(el.dataset.tab)
    if (el.dataset.tag !== undefined) return toggleFilter(el.dataset.tag) // '' = uncategorised
    if (el.dataset.tagclear) return clearFilter()
    if (el.dataset.view) return act(() => hooks.onOpenViewer(selectedIds(root), el.dataset.view))
    if (el.dataset.section) return selectSection(el.dataset.section)
    if (el.dataset.id) return selectToggle(el.dataset.id)
    switch (el.dataset.act) {
      case 'addTab': return act(hooks.onAddTab)
      case 'add': return act(hooks.onAdd)
      case 'paste': return act(hooks.onPaste)
      case 'menu': return act(hooks.onMenu)
      case 'export': return act(hooks.onExport)
      case 'edit': return act(() => hooks.onEdit([...store.selected][0]))
      case 'clear': return clearSelection()
      case 'categorize': return act(categorize)
      case 'toggleTags': return setShowTags(!store.showTags)
      case 'toSchool': return act(() => move('school'))
      case 'toHome': return act(() => move('home'))
      case 'del': if (confirm(t('render.confirmDelete'))) return act(deleteSelected)
    }
  })
}

/** Category for the whole selection; the pill they all share starts chosen. */
async function categorize() {
  const sel = store.items.filter((i) => store.selected.has(i.id))
  const shared = new Set(sel.map((i) => i.category ?? ''))
  const category = await askCategory(sel.length, shared.size === 1 ? [...shared][0] : undefined)
  if (category !== null) await categorizeSelected(category)
}

const LONG_PRESS_MS = 450

/** Ids of the tiles in the same section as `el`, in display order. */
const sectionIds = (el) => [...el.closest('.grid').querySelectorAll('.item[data-id]')].map((n) => n.dataset.id)

/** Selected tiles of the current tab in display order (school section, then home). */
const selectedIds = (root) => [...root.querySelectorAll('.item.selected[data-id]')].map((n) => n.dataset.id)

// What a long-press does, per pressable element.
const LONG_PRESS = [
  { sel: '.chip[data-tab]', run: (el) => hooks.onTabLongPress(el.dataset.tab) }, // tab manager
  { sel: '.item[data-id]', run: (el) => hooks.onOpenViewer(sectionIds(el), el.dataset.id) }, // full-screen viewer
]
const pressable = (target) => {
  if (target.closest('.open')) return null // the open button acts on tap only
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
    noteActivator(hit.el.querySelector('.pick') ?? hit.el) // the viewer / manager returns focus here
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
