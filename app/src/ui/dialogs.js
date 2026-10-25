// Add-flow dialogs. Built once on first use and appended to <body>, so the whole-screen
// innerHTML re-render of the main screen never touches them.
import { store, rotateAndEdit, prepareReplacement, subscribe } from '../store.js'
import { categoryName } from '../categories.js'
import { errorMessage } from './model.js'
import { cameraIcon, imageIcon, rotateIcon } from './icons.js'
import { getPhoto } from '../db.js'
import { normTurns } from '../rotate.js'
import { esc } from './render.js'
import { t, onLangChange } from '../i18n.js'
import { resolve, lastActivator, locator, keepFocus } from './focus.js'


// ---- Shared modal behaviour -------------------------------------------------------------
const FOCUSABLE = 'input:not([type="hidden"]), select, textarea, button, a[href], [tabindex]:not([tabindex="-1"])'
const usable = (el) => !el.disabled && !el.hidden && !el.closest('[hidden], [inert]') && el.getAttribute('tabindex') !== '-1'
const firstControl = (el) => [...el.querySelectorAll(FOCUSABLE)].find(usable)
/** The opener is gone (redrawn away): land on the topmost open modal, else the menu button, never <body>. */
function focusFallback() {
  const top = [...stack].reverse().find((m) => !m.done && m.isOpen())
  const target = (top && firstControl(top.el)) || document.querySelector('.menu') || document.querySelector('h1')
  if (target && !target.matches('button, input, select, textarea, a[href]')) target.setAttribute('tabindex', '-1')
  target?.focus({ preventScroll: true })
}
/** Modals (and the viewer) that are open, or closed with their `close` event still pending. */
const stack = []
let titleSeq = 0

/** Name a dialog after its heading unless it already has a name. */
export function labelDialog(el) {
  if (el.getAttribute('aria-label')) return
  const h = el.querySelector('h3')
  if (!h) return
  if (!h.id) h.id = `dlgTitle${++titleSeq}`
  el.setAttribute('aria-labelledby', h.id)
}

/**
 * Open a modal the accessible way: name it, move focus to its first control, let Escape close it
 * and give focus back to whatever opened it. Used by every dialog and the viewer.
 * A <dialog> is shown with showModal() and releases itself on `close`; any other element (the
 * viewer) is shown by its caller, which calls the returned release() when it hides.
 * @param {HTMLElement} el
 * @param {{returnFocus?: Element|string|null}} [opts] opener to refocus on close; defaults to the focused control
 * @returns {() => void} release()
 */
export function openModal(el, { returnFocus = null } = {}) {
  const isDialog = el instanceof HTMLDialogElement
  // A modal that was just closed (its close event not yet fired) hands its opener on: the menu
  // drawer closes right before the dialog it launches opens.
  const handed = stack.find((m) => !m.done && !m.isOpen())
  const active = document.activeElement
  const own = active && active !== document.body && !active.closest('dialog:not([open])') ? active : null
  const opener = resolve(returnFocus) ?? handed?.opener?.el ?? own ?? lastActivator()
  const entry = { el, opener: opener ? { el: opener, loc: locator(opener) } : null, done: false, handedOff: false, isOpen: () => (isDialog ? el.open : true) }
  labelDialog(el)
  const inerted = []
  if (isDialog) el.showModal() // throws if already open: nothing is registered then
  else {
    // A plain element has no native modality: make the rest of the page inert while it is up.
    for (const n of document.body.children) if (n !== el && !n.inert) { n.inert = true; inerted.push(n) }
  }
  if (handed) handed.handedOff = true
  stack.push(entry)
  firstControl(el)?.focus({ preventScroll: true })
  const onKey = (e) => {
    if (e.key !== 'Escape' || e.defaultPrevented || !isDialog) return
    e.preventDefault() // closed here, through the same path as the native Escape (honours `cancel`)
    if (el.dispatchEvent(new Event('cancel', { cancelable: true }))) el.close()
  }
  if (isDialog) el.addEventListener('keydown', onKey)
  const release = () => {
    if (entry.done) return
    entry.done = true
    stack.splice(stack.indexOf(entry), 1)
    for (const n of inerted) n.inert = false
    if (isDialog) el.removeEventListener('keydown', onKey)
    if (entry.handedOff) return // the modal that replaced this one owns focus now
    const back = entry.opener && (resolve(entry.opener.el) ?? resolve(entry.opener.loc))
    if (back && !back.disabled && !back.hidden && !back.closest('[hidden]')) back.focus({ preventScroll: true })
    else focusFallback()
  }
  if (isDialog) el.addEventListener('close', release, { once: true })
  return release
}

let filesHandler = () => {}
/** One-shot handler for the next picked files (change photo); null = the add flow. */
let pickOverride = null
/** The add flow registers what happens with picked files. */
export function setFilesHandler(fn) { filesHandler = fn }

let manageCategories = () => {}
/** categories.js registers the manager opener (it imports this module, so no import back). */
export function setManageCategories(fn) { manageCategories = fn }

/**
 * Single-choice category pills ("Nessuna" clears) inside `box`. Redraws on store changes,
 * so categories created from the manager link show up while the dialog is open.
 * @returns {{get: () => string, stop: () => void}} get() = chosen id or '' for none
 */
function categoryPicker(box, initial = '') {
  let chosen = initial
  const draw = () => keepFocus(box, redraw)
  const redraw = () => {
    if (chosen && !store.categories.some((c) => c.id === chosen)) chosen = ''
    if (!store.categories.length) {
      box.innerHTML = `<span class="hint">${t('dialogs.categoryHint')}</span><button type="button" class="linkbtn" data-managecat>${t('dialogs.categoryManage')}</button>`
      return
    }
    const pill = (id, label) => `<button type="button" class="chip tag${chosen === id ? ' on' : ''}" data-cat="${esc(id)}" aria-pressed="${chosen === id}">${label}</button>`
    box.innerHTML = pill('', t('dialogs.categoryNone')) + store.categories.map((c) => pill(c.id, esc(categoryName(c)))).join('')
  }
  box.onclick = (e) => {
    if (e.target.closest('[data-managecat]')) return manageCategories()
    const b = e.target.closest('[data-cat]')
    if (!b) return
    chosen = b.dataset.cat
    draw()
  }
  draw()
  const off = subscribe(draw)
  return { get: () => chosen, stop: () => { off(); box.onclick = null } }
}

let dom = null
let nodes = []
// Dialog text is baked in at build time: drop the (closed) dialogs so the next use rebuilds them.
onLangChange(() => { for (const n of nodes) n.remove(); nodes = []; dom = null })
function ensureDom() {
  if (dom) return dom
  const wrap = document.createElement('div')
  wrap.innerHTML = `
    <dialog id="source"><form method="dialog">
      <h3 id="sourceTitle">${t('dialogs.addTitle')}</h3>
      <div class="row">
        <button type="button" data-source="camera" class="primary">${cameraIcon}${t('dialogs.camera')}</button>
        <button type="button" data-source="gallery">${imageIcon}${t('dialogs.gallery')}</button>
      </div>
      <button value="" class="cancel">${t('common.cancel')}</button>
    </form></dialog>
    <dialog id="newItem"><form method="dialog">
      <h3 id="newTitle"></h3>
      <div class="preview" id="newPreview"></div>
      <input type="text" id="newLabel" placeholder="${t('dialogs.labelPlaceholder')}" autocomplete="off">
      <div class="catpick" id="newCat" role="group" aria-label="${t('dialogs.category')}"></div>
      <div class="row">
        <button value="school" class="primary">🏫 ${t('loc.school')}</button>
        <button value="home">🏠 ${t('loc.home')}</button>
      </div>
      <button value="" class="cancel">${t('common.cancel')}</button>
    </form></dialog>
    <dialog id="editItem"><form method="dialog">
      <h3>${t('dialogs.editTitle')}</h3>
      <input type="text" id="editLabel" placeholder="${t('dialogs.label')}" aria-label="${t('dialogs.label')}" autocomplete="off">
      <select id="editTab" aria-label="${t('dialogs.tab')}"></select>
      <div class="catpick" id="editCat" role="group" aria-label="${t('dialogs.category')}"></div>
      <img id="editPreview" class="edit-preview" alt="" hidden>
      <button type="button" id="editRotate">${rotateIcon}${t('common.rotate')}</button>
      <button type="button" id="editPhoto">${t('dialogs.changePhotoTitle')}</button>
      <div class="row">
        <button value="" class="cancel-inline">${t('common.cancel')}</button>
        <button value="ok" class="primary" id="editSave">${t('common.save')}</button>
      </div>
    </form></dialog>
    <input type="file" id="camera" accept="image/*" capture="environment" hidden>
    <input type="file" id="gallery" accept="image/*" multiple hidden>`
  nodes = [...wrap.children]
  document.body.append(...nodes)
  const $ = (id) => document.getElementById(id)
  dom = { source: $('source'), newItem: $('newItem'), title: $('newTitle'), preview: $('newPreview'), label: $('newLabel'),
    sourceTitle: $('sourceTitle'), gallery: $('gallery'), newCat: $('newCat'), editCat: $('editCat'),
    edit: $('editItem'), editLabel: $('editLabel'), editTab: $('editTab'), editPhoto: $('editPhoto'), editRotate: $('editRotate'), editPreview: $('editPreview'), editSave: $('editSave') }
  // Click the input inside the same tap, so the browser lets the picker open.
  dom.source.addEventListener('click', (e) => {
    const b = e.target.closest('[data-source]')
    if (!b) return
    dom.source.close()
    $(b.dataset.source).click()
  })
  // Enter would hit the first submit button (Annulla); make it Salva.
  dom.editLabel.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return
    e.preventDefault()
    dom.edit.querySelector('form').requestSubmit(dom.editSave)
  })
  // Camera (capture opens the rear camera directly) and gallery (multi-select) share one handler.
  for (const id of ['camera', 'gallery']) $(id).addEventListener('change', (e) => {
    const files = [...e.target.files]; e.target.value = ''
    const handler = pickOverride ?? filesHandler
    pickOverride = null
    handler(files)
  })
  return dom
}

/** Prepare the DOM early so the first tap on "Aggiungi" is not delayed. */
export function initDialogs() { ensureDom() }

/** @param {((files: File[]) => void)|null} [override] take the next picked files instead of the add flow (single photo) */
export function openSourcePicker(override = null) {
  const d = ensureDom()
  pickOverride = override
  d.sourceTitle.textContent = override ? t('dialogs.changePhotoTitle') : t('dialogs.addTitle')
  d.gallery.multiple = !override
  openModal(d.source)
}

/**
 * Ask where new photos go and an optional description.
 * @param {string[]} previewUrls
 * @param {string} tabName
 * @returns {Promise<{location: 'school'|'home', label: string, category?: string}|null>} null if cancelled
 */
export function askNewItem(previewUrls, tabName) {
  const d = ensureDom()
  const { newItem: dlg, title, preview, label } = d
  const n = previewUrls.length
  title.textContent = n === 1 ? t('dialogs.newItem', { tab: tabName }) : t('dialogs.newItems', { n, tab: tabName })
  preview.replaceChildren(...previewUrls.map((src) => Object.assign(document.createElement('img'), { src, alt: '' })))
  label.value = ''
  // Several photos: one description would be wrong for all of them, so skip it.
  label.hidden = n > 1
  const picker = categoryPicker(d.newCat) // none preselected
  dlg.returnValue = ''
  openModal(dlg)
  return new Promise((resolve) => dlg.addEventListener('close', () => {
    const category = picker.get()
    picker.stop()
    resolve(dlg.returnValue ? { location: dlg.returnValue, label: label.hidden ? '' : label.value.trim(), ...(category ? { category } : {}) } : null)
  }, { once: true }))
}

/** Edit dialog for one item: label, tab, photo. Saving goes through the store; errors are reported here. */
export function openEditItem(id) {
  const it = store.items.find((i) => i.id === id)
  if (!it) return
  const d = ensureDom()
  d.editLabel.value = it.label || ''
  d.editTab.replaceChildren(...store.tabs.map((t) => Object.assign(new Option(t.name, t.id), { selected: t.id === it.tabId })))
  // The picked photo and the rotation are only held here; Salva commits them with the fields, Annulla drops them.
  let pending = null
  let previewUrl = ''
  let angle = 0 // degrees shown in the preview, keeps growing so the turn never spins back
  let closed = false
  const setPreview = (blob) => {
    if (previewUrl) URL.revokeObjectURL(previewUrl)
    previewUrl = URL.createObjectURL(blob)
    d.editPreview.src = previewUrl
    d.editPreview.hidden = false
  }
  const clearPreview = () => { if (previewUrl) URL.revokeObjectURL(previewUrl); previewUrl = ''; d.editPreview.hidden = true; d.editPreview.removeAttribute('src'); d.editPreview.style.transform = '' }
  clearPreview()
  // Show the stored photo so a rotation is visible even without picking a new one.
  getPhoto(store.db, it.photoId).then((blob) => { if (blob && !closed && !pending) setPreview(blob) }).catch(() => {})
  d.editRotate.onclick = () => {
    angle += 90
    d.editPreview.style.transform = `rotate(${angle}deg)`
  }
  d.editPhoto.textContent = t('dialogs.changePhotoTitle')
  d.editPhoto.onclick = () => openSourcePicker(async (files) => {
    if (!files[0]) return
    try {
      pending = await prepareReplacement(files[0])
      setPreview(pending.blob) // a rotation already chosen applies to this new photo
      d.editPhoto.textContent = t('dialogs.changeAgain')
    } catch (e) {
      if (e?.message === 'not-an-image') alert(t('add.skipped', { n: 1 }))
      else reportError(e)
    }
  })
  const picker = categoryPicker(d.editCat, it.category ?? '')
  d.edit.returnValue = ''
  d.edit.addEventListener('close', () => {
    closed = true
    clearPreview()
    const category = picker.get() || null // null clears
    picker.stop()
    if (d.edit.returnValue !== 'ok') return
    const patch = { label: d.editLabel.value, tabId: d.editTab.value, category }
    const turns = normTurns(angle / 90)
    // Reading, rotating and saving happen inside the store's queue, so quick saves can't race.
    rotateAndEdit(id, patch, turns, pending).then((rotationError) => { if (rotationError) reportError(rotationError) }).catch(reportError)
  }, { once: true })
  openModal(d.edit)
}

/** Single place where a failed action reaches the user. */
export function reportError(e) {
  if (e?.name === 'QuotaExceededError') alert(t('dialogs.quota'))
  else alert(errorMessage(e, store))
}
