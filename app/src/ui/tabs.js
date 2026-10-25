// Tab dialogs: "Nuova scheda" and the tab manager (rename / move / delete).
// DOM is built once and appended to <body>, like dialogs.js, so main-screen re-renders never touch it.
import { store, addTab, renameTab, reorderTabs, removeTab } from '../store.js'
import { hooks } from './render.js'
import { reportError, openModal } from './dialogs.js'
import { t, onLangChange } from '../i18n.js'

let dom = null
let nodes = []
// Dialog text is baked in at build time: drop the (closed) dialogs so the next use rebuilds them.
onLangChange(() => { for (const n of nodes) n.remove(); nodes = []; dom = null })
function ensureDom() {
  if (dom) return dom
  const wrap = document.createElement('div')
  wrap.innerHTML = `
    <dialog id="newTab"><form method="dialog">
      <h3>${t('tabs.newTitle')}</h3>
      <input type="text" id="newTabName" placeholder="${t('tabs.placeholder')}" autocomplete="off">
      <div class="row">
        <button value="" class="cancel-inline">${t('common.cancel')}</button>
        <button value="ok" class="primary" id="newTabOk" disabled>${t('tabs.create')}</button>
      </div>
    </form></dialog>
    <dialog id="tabMgr"><form method="dialog">
      <h3>${t('tabs.manageTitle')}</h3>
      <input type="text" id="mgrName" autocomplete="off" aria-label="${t('tabs.nameLabel')}">
      <button type="button" class="primary" id="mgrSave">${t('tabs.saveName')}</button>
      <div class="row mgr-row">
        <button type="button" id="mgrLeft">${t('tabs.moveLeft')}</button>
        <button type="button" id="mgrRight">${t('tabs.moveRight')}</button>
      </div>
      <button type="button" class="danger" id="mgrDel">${t('tabs.delete')}</button>
      <p class="note" id="mgrNote" hidden>${t('tabs.needOne')}</p>
      <button value="" class="cancel">${t('common.close')}</button>
    </form></dialog>`
  nodes = [...wrap.children]
  document.body.append(...nodes)
  const $ = (id) => document.getElementById(id)
  dom = {
    newTab: $('newTab'), newName: $('newTabName'), newOk: $('newTabOk'),
    mgr: $('tabMgr'), name: $('mgrName'), save: $('mgrSave'),
    left: $('mgrLeft'), right: $('mgrRight'), del: $('mgrDel'), note: $('mgrNote'),
  }
  dom.newName.addEventListener('input', () => { dom.newOk.disabled = !dom.newName.value.trim() })
  // Enter would hit the first submit button (the cancel one); make it the primary action.
  dom.newName.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return
    e.preventDefault()
    if (!dom.newOk.disabled) dom.newTab.querySelector('form').requestSubmit(dom.newOk)
  })
  dom.name.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return
    e.preventDefault()
    manage('mgrSave')
  })
  dom.newTab.addEventListener('close', () => {
    if (dom.newTab.returnValue === 'ok' && dom.newName.value.trim()) addTab(dom.newName.value).catch(reportError)
  })
  dom.mgr.addEventListener('click', (e) => {
    const b = e.target.closest('button[id^="mgr"]')
    if (b) manage(b.id)
  })
  return dom
}

let mgrTabId = null
const tabIndex = () => store.tabs.findIndex((t) => t.id === mgrTabId)

function refreshManager() {
  const d = ensureDom()
  const i = tabIndex()
  d.left.disabled = i <= 0
  d.right.disabled = i < 0 || i >= store.tabs.length - 1
  const last = store.tabs.length <= 1
  d.del.disabled = last
  d.note.hidden = !last
}

async function manage(which) {
  const d = ensureDom()
  try {
    if (which === 'mgrSave') {
      if (!d.name.value.trim()) return
      await renameTab(mgrTabId, d.name.value)
    } else if (which === 'mgrLeft' || which === 'mgrRight') {
      const ids = store.tabs.map((t) => t.id)
      const i = ids.indexOf(mgrTabId)
      const j = which === 'mgrLeft' ? i - 1 : i + 1
      if (i < 0 || j < 0 || j >= ids.length) return
      ;[ids[i], ids[j]] = [ids[j], ids[i]]
      await reorderTabs(ids)
    } else if (which === 'mgrDel') {
      const tab = store.tabs[tabIndex()]
      const n = store.items.filter((it) => it.tabId === mgrTabId).length
      if (n && !confirm(t('tabs.confirmDelete', { name: tab.name, n }))) return
      await removeTab(mgrTabId)
      d.mgr.close()
      return
    }
    refreshManager()
  } catch (e) {
    reportError(e)
  }
}

/** Dialog to rename, move or delete a tab. @param {string} [tabId] defaults to the current tab */
export function openTabManager(tabId = store.currentTabId) {
  const tab = store.tabs.find((t) => t.id === tabId)
  if (!tab) return
  const d = ensureDom()
  mgrTabId = tab.id
  d.name.value = tab.name
  refreshManager()
  openModal(d.mgr)
}

export function openNewTab() {
  const d = ensureDom()
  d.newName.value = ''
  d.newOk.disabled = true
  d.newTab.returnValue = ''
  openModal(d.newTab)
}

export function initTabs() {
  ensureDom()
  hooks.onAddTab = openNewTab
  hooks.onTabLongPress = openTabManager
}
