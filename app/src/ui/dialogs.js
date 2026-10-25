// Add-flow dialogs. Built once on first use and appended to <body>, so the whole-screen
// innerHTML re-render of the main screen never touches them.
import { store, editItem, prepareReplacement } from '../store.js'
import { errorMessage } from './model.js'
import { cameraIcon, imageIcon } from './icons.js'
import { t, onLangChange } from '../i18n.js'

let filesHandler = () => {}
/** One-shot handler for the next picked files (change photo); null = the add flow. */
let pickOverride = null
/** The add flow registers what happens with picked files. */
export function setFilesHandler(fn) { filesHandler = fn }

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
      <img id="editPreview" class="edit-preview" alt="" hidden>
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
    sourceTitle: $('sourceTitle'), gallery: $('gallery'),
    edit: $('editItem'), editLabel: $('editLabel'), editTab: $('editTab'), editPhoto: $('editPhoto'), editPreview: $('editPreview'), editSave: $('editSave') }
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
  d.source.showModal()
}

/**
 * Ask where new photos go and an optional description.
 * @param {string[]} previewUrls
 * @param {string} tabName
 * @returns {Promise<{location: 'school'|'home', label: string}|null>} null if cancelled
 */
export function askNewItem(previewUrls, tabName) {
  const { newItem: dlg, title, preview, label } = ensureDom()
  const n = previewUrls.length
  title.textContent = n === 1 ? t('dialogs.newItem', { tab: tabName }) : t('dialogs.newItems', { n, tab: tabName })
  preview.replaceChildren(...previewUrls.map((src) => Object.assign(document.createElement('img'), { src, alt: '' })))
  label.value = ''
  // Several photos: one description would be wrong for all of them, so skip it.
  label.hidden = n > 1
  dlg.returnValue = ''
  dlg.showModal()
  return new Promise((resolve) => dlg.addEventListener('close', () =>
    resolve(dlg.returnValue ? { location: dlg.returnValue, label: label.hidden ? '' : label.value.trim() } : null), { once: true }))
}

/** Edit dialog for one item: label, tab, photo. Saving goes through the store; errors are reported here. */
export function openEditItem(id) {
  const it = store.items.find((i) => i.id === id)
  if (!it) return
  const d = ensureDom()
  d.editLabel.value = it.label || ''
  d.editTab.replaceChildren(...store.tabs.map((t) => Object.assign(new Option(t.name, t.id), { selected: t.id === it.tabId })))
  // The picked photo is only held here; Salva commits it with the fields, Annulla drops it.
  let pending = null
  let previewUrl = ''
  const clearPreview = () => { if (previewUrl) URL.revokeObjectURL(previewUrl); previewUrl = ''; d.editPreview.hidden = true; d.editPreview.removeAttribute('src') }
  clearPreview()
  d.editPhoto.textContent = t('dialogs.changePhotoTitle')
  d.editPhoto.onclick = () => openSourcePicker(async (files) => {
    if (!files[0]) return
    try {
      pending = await prepareReplacement(files[0])
      clearPreview()
      previewUrl = URL.createObjectURL(pending.blob)
      d.editPreview.src = previewUrl
      d.editPreview.hidden = false
      d.editPhoto.textContent = t('dialogs.changeAgain')
    } catch (e) {
      if (e?.message === 'not-an-image') alert(t('add.skipped', { n: 1 }))
      else reportError(e)
    }
  })
  d.edit.returnValue = ''
  d.edit.addEventListener('close', () => {
    clearPreview()
    if (d.edit.returnValue !== 'ok') return
    editItem(id, { label: d.editLabel.value, tabId: d.editTab.value }, pending).catch(reportError)
  }, { once: true })
  d.edit.showModal()
}

/** Single place where a failed action reaches the user. */
export function reportError(e) {
  if (e?.name === 'QuotaExceededError') alert(t('dialogs.quota'))
  else alert(errorMessage(e, store))
}
