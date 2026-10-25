// Category manager dialog (rename / reorder / delete / add defaults). Built once and appended to
// <body> like tabs.js; the list is redrawn after each action, never while typing.
import { store, addCategory, renameCategory, reorderCategories, removeCategory, addDefaultCategories } from '../store.js'
import { categoryName, missingDefaults } from '../categories.js'
import { hooks, esc } from './render.js'
import { reportError, setManageCategories, openModal } from './dialogs.js'
import { keepFocus } from './focus.js'
import { t, onLangChange } from '../i18n.js'

let dom = null
let nodes = []
// Dialog text is baked in at build time: drop the (closed) dialog so the next use rebuilds it.
onLangChange(() => { for (const n of nodes) n.remove(); nodes = []; dom = null })

function ensureDom() {
  if (dom) return dom
  const wrap = document.createElement('div')
  wrap.innerHTML = `<dialog id="catMgr"><form method="dialog">
      <h3>${t('category.manageTitle')}</h3>
      <p class="note" id="catEmpty" hidden>${t('category.empty')}</p>
      <ul class="catlist" id="catList"></ul>
      <div class="row catnew">
        <input type="text" id="catNew" placeholder="${t('category.newPlaceholder')}" aria-label="${t('category.newPlaceholder')}" autocomplete="off">
        <button type="button" class="primary" data-cat-act="add">${t('category.add')}</button>
      </div>
      <button type="button" id="catDefaults" data-cat-act="defaults" hidden>${t('category.addDefaults')}</button>
      <button value="" class="cancel">${t('common.close')}</button>
    </form></dialog>`
  nodes = [...wrap.children]
  document.body.append(...nodes)
  const $ = (id) => document.getElementById(id)
  dom = { dlg: $('catMgr'), list: $('catList'), empty: $('catEmpty'), input: $('catNew'), defaults: $('catDefaults') }
  dom.dlg.addEventListener('click', (e) => {
    const b = e.target.closest('[data-cat-act]')
    if (b) run(b.dataset.catAct, b.closest('[data-id]')?.dataset.id)
  })
  // Enter would hit the first submit button (Chiudi): make it save the field instead.
  dom.dlg.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.target.tagName !== 'INPUT') return
    e.preventDefault()
    if (e.target === dom.input) run('add')
    else run('rename', e.target.closest('[data-id]').dataset.id)
  })
  // Leaving a renamed field saves it too (a no-op when nothing changed).
  dom.dlg.addEventListener('change', (e) => {
    const row = e.target.closest('[data-id]')
    if (row && e.target !== dom.input) run('rename', row.dataset.id)
  })
  return dom
}

function draw() { keepFocus(ensureDom().list, drawList) }
function drawList() {
  const d = ensureDom()
  const cats = store.categories
  d.empty.hidden = cats.length > 0
  d.list.innerHTML = cats.map((c, i) => `<li data-id="${esc(c.id)}">
      <input type="text" value="${esc(categoryName(c))}" aria-label="${t('category.nameLabel')}" autocomplete="off">
      <button type="button" data-cat-act="up" aria-label="${t('category.up')}"${i === 0 ? ' disabled' : ''}>↑</button>
      <button type="button" data-cat-act="down" aria-label="${t('category.down')}"${i === cats.length - 1 ? ' disabled' : ''}>↓</button>
      <button type="button" class="danger" data-cat-act="del" aria-label="${t('category.delete')}">✕</button></li>`).join('')
  d.defaults.hidden = !missingDefaults(cats).length
}

async function run(act, id) {
  const d = ensureDom()
  // A rename leaves the row as typed: redrawing would detach a button tapped right after (blur fires first).
  let redraw = act !== 'rename'
  try {
    if (act === 'add') {
      const name = d.input.value.trim()
      if (!name) return
      await addCategory(name)
      d.input.value = ''
    } else if (act === 'defaults') {
      await addDefaultCategories()
    } else if (act === 'rename') {
      const input = d.list.querySelector(`[data-id="${CSS.escape(id)}"] input`)
      if (input?.value.trim()) await renameCategory(id, input.value)
      else redraw = true // blank: restore the old name
    } else if (act === 'up' || act === 'down') {
      const ids = store.categories.map((c) => c.id)
      const i = ids.indexOf(id)
      const j = act === 'up' ? i - 1 : i + 1
      if (i < 0 || j < 0 || j >= ids.length) return
      ;[ids[i], ids[j]] = [ids[j], ids[i]]
      await reorderCategories(ids)
    } else if (act === 'del') {
      const cat = store.categories.find((c) => c.id === id)
      if (!cat) return
      const n = store.items.filter((it) => it.category === id).length
      if (n && !confirm(t('category.delete.confirm', { name: categoryName(cat), n }))) return
      await removeCategory(id)
    }
  } catch (e) {
    reportError(e)
    redraw = true
  }
  if (redraw) draw()
}

export function openCategoryManager() {
  const d = ensureDom()
  if (d.dlg.open) return
  d.input.value = ''
  draw()
  openModal(d.dlg)
}

export function initCategories() {
  ensureDom()
  hooks.onManageCategories = openCategoryManager
  setManageCategories(openCategoryManager)
}
