// Side drawer (slides from the right): backup info, export/import, tabs, "Da rifare", theme, language.
import { store, load, runExclusive } from '../store.js'
import { getMeta, setMeta } from '../db.js'
import { exportBackup, backupFileName } from '../backup/exporter.js'
import { hooks } from './render.js'
import { openTabManager } from './tabs.js'
import { openCategoryManager } from './categories.js'
import { reportError, openModal, labelDialog } from './dialogs.js'
import { keepFocus } from './focus.js'
import { withBusy, importFile, pickImportFile } from './importFlow.js'
import { getTheme, setTheme } from '../theme.js'
import { t, getLangChoice, setLang, onLangChange } from '../i18n.js'
import { currentPlatform, isStandalone } from '../platform.js'
import { canPromptInstall, promptInstall } from '../install.js'
import { openInstallSteps, openUninstallSteps } from './appDialogs.js'
import { openWipeFlow } from './wipeFlow.js'
import { menuFooter } from './about.js'
import { downloadIcon, uploadIcon, layersIcon, tagsIcon, todoIcon, monitorIcon, sunIcon, moonIcon, smartphoneIcon, logOutIcon, eraseIcon } from './icons.js'
import { backupInfoLine, persistLine, removeTodo, failureRow, exportErrorMessage } from './model.js'

let dlg = null
let db = null

const themes = () => [['auto', monitorIcon, t('menu.themeAuto')], ['light', sunIcon, t('menu.themeLight')], ['dark', moonIcon, t('menu.themeDark')]]
// Language names stay in their own language so they are findable from the wrong one.
const langs = () => [['auto', t('menu.langAuto')], ['it', 'Italiano'], ['en', 'English']]

/** Menu row: icon holder + label (+ optional right-hand pill). */
const menuItem = (act, icon, label, extra = '', cls = '') => `<button type="button" class="menuItem${cls}" data-menu="${act}"${act === 'todo' ? ' id="todoBtn" hidden' : ''}><span class="ic">${icon}</span>${label}${extra}</button>`

/** Ask the browser not to evict our data; null when unsupported. */
async function persistence() {
  if (!navigator.storage?.persist) return null
  try { return (await navigator.storage.persisted()) || (await navigator.storage.persist()) } catch { return null }
}

function renderThemeSeg() {
  const cur = getTheme()
  const seg = dlg.querySelector('#themeSeg')
  keepFocus(seg, () => { seg.innerHTML = themes().map(([v, icon, l]) => `<button type="button" data-theme-choice="${v}" class="${v === cur ? 'active' : ''}" aria-pressed="${v === cur}">${icon}${l}</button>`).join('') })
}

function renderLangSeg() {
  const cur = getLangChoice()
  const seg = dlg.querySelector('#langSeg')
  keepFocus(seg, () => { seg.innerHTML = langs().map(([v, l]) => `<button type="button" data-lang-choice="${v}" class="${v === cur ? 'active' : ''}" aria-pressed="${v === cur}">${l}</button>`).join('') })
}

/** Fill the dynamic parts (info lines, todo badge, segmented controls). */
async function refresh() {
  const todo = (await getMeta(db, 'todo')) ?? []
  const last = await getMeta(db, 'lastBackupAt')
  dlg.querySelector('#backupInfo').textContent = backupInfoLine(store.items.length, last)
  dlg.querySelector('#persistInfo').textContent = ''
  const todoBtn = dlg.querySelector('#todoBtn')
  todoBtn.hidden = !todo.length
  todoBtn.querySelector('.badge').textContent = todo.length
  renderThemeSeg()
  renderLangSeg()
  persistence().then((p) => { dlg.querySelector('#persistInfo').textContent = persistLine(p) })
}

async function openMenu() {
  if (!dlg) build()
  if (dlg.open) return // double tap on the menu button
  await refresh()
  if (!dlg.open) openModal(dlg)
}

const menuHtml = () => `<h3>${t('menu.title')} <button type="button" class="close" data-menu="close" aria-label="${t('common.close')}">✕</button></h3>
    <h4>${t('menu.backup')}</h4>
    <div class="info"><span id="backupInfo"></span><br><span id="persistInfo"></span></div>
    ${menuItem('export', downloadIcon, t('menu.export'))}
    ${menuItem('import', uploadIcon, t('menu.import'))}
    <h4>${t('menu.tabsSection')}</h4>
    ${menuItem('tabs', layersIcon, t('menu.manageTabs'))}
    ${menuItem('categories', tagsIcon, t('menu.manageCategories'))}
    ${menuItem('todo', todoIcon, t('menu.todo'), '<span class="badge"></span>')}
    <h4>${t('menu.theme')}</h4>
    <div class="seg" id="themeSeg"></div>
    <h4>${t('menu.language')}</h4>
    <div class="seg" id="langSeg"></div>
    <h4>${t('menu.app')}</h4>
    ${isStandalone() ? '' : menuItem('install', smartphoneIcon, t('menu.installApp'))}
    ${menuItem('uninstall', logOutIcon, t('menu.uninstallHow'))}
    ${menuItem('wipe', eraseIcon, t('menu.wipe'), '', ' danger')}
    ${menuFooter()}`

function build() {
  dlg = document.createElement('dialog')
  dlg.id = 'menu'
  dlg.innerHTML = menuHtml()
  document.body.append(dlg)
  // Relabel in place (the drawer stays open while the language is switched from it).
  onLangChange(() => { keepFocus(dlg, () => { dlg.innerHTML = menuHtml(); labelDialog(dlg) }); if (todoDlg?.open) renderTodo(); refresh() })
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) { // the dialog itself is the target for both its padding and the backdrop
      const r = dlg.getBoundingClientRect()
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dlg.close()
      return
    }
    const theme = e.target.closest('[data-theme-choice]')
    if (theme) { setTheme(theme.dataset.themeChoice); renderThemeSeg(); return } // stay open to see the result
    const lang = e.target.closest('[data-lang-choice]')
    if (lang) { setLang(lang.dataset.langChoice); return } // onLangChange redraws the drawer
    const item = e.target.closest('[data-menu]')
    if (!item) return
    dlg.close()
    const run = { close: () => {}, export: () => runExport(), import: () => pickImportFile(db), tabs: () => openTabManager(), categories: openCategoryManager, todo: openTodo, install: runInstall, uninstall: () => openUninstallSteps(), wipe: () => openWipeFlow({ db, onExport: runExport }) }[item.dataset.menu]
    run()
  })
  // Swipe right on the drawer to close it.
  let x0 = null
  dlg.addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX }, { passive: true })
  dlg.addEventListener('touchend', (e) => {
    if (x0 !== null && e.changedTouches[0].clientX - x0 > 60) dlg.close()
    x0 = null
  })
}

/** Export with share sheet / download; tells the user only what they need to know. */
export async function runExport() {
  const now = new Date()
  let result
  try {
    // Exclusive: a move during the export would be counted, then zeroed with the counter.
    result = await withBusy(() => runExclusive(() => exportBackup(db, { now })))
  } catch (e) {
    alert(exportErrorMessage(e, store))
    return
  }
  if (result === 'cancelled') return
  if (result === 'downloaded') alert(t(currentPlatform() === 'ios' ? 'menu.fileSavedIos' : 'menu.fileSaved', { name: backupFileName(now) }))
  await load(db) // refreshes the unsaved-changes banner
}

/** Native prompt when the browser offered one, else the manual steps for this platform. */
async function runInstall() {
  if (canPromptInstall()) await promptInstall()
  else openInstallSteps()
}

let todoDlg = null
async function openTodo() {
  if (!todoDlg) {
    todoDlg = document.createElement('dialog')
    document.body.append(todoDlg)
    todoDlg.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-done]')
      if (!b) return
      try {
        const list = (await getMeta(db, 'todo')) ?? []
        const i = Number(b.dataset.done)
        if (i < list.length) await setMeta(db, 'todo', removeTodo(list, i))
        await renderTodo()
      } catch (err) { reportError(err) }
    })
  }
  await renderTodo()
  if (!todoDlg.open) openModal(todoDlg)
}

async function renderTodo() {
  const list = (await getMeta(db, 'todo')) ?? []
  if (!list.length) { todoDlg.close(); return }
  keepFocus(todoDlg, () => { todoDlg.innerHTML = `<form method="dialog"><h3>${t('menu.todoTitle', { n: list.length })}</h3>
    <ul class="failures">${list.map((f, i) => failureRow(f, `<button type="button" data-done="${i}">${t('menu.done')}</button>`)).join('')}</ul>
    <button value="" class="cancel">${t('common.close')}</button></form>`; labelDialog(todoDlg) })
}

export function initMenu(database) {
  db = database
  hooks.onMenu = openMenu
  hooks.onExport = runExport
  hooks.onImportFile = (file) => importFile(db, file)
}
