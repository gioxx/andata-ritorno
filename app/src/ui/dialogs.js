// Add-flow dialogs. Built once on first use and appended to <body>, so the whole-screen
// innerHTML re-render of the main screen never touches them.
let filesHandler = () => {}
/** The add flow registers what happens with picked files. */
export function setFilesHandler(fn) { filesHandler = fn }

let dom = null
function ensureDom() {
  if (dom) return dom
  const wrap = document.createElement('div')
  wrap.innerHTML = `
    <dialog id="source"><form method="dialog">
      <h3>Aggiungi capi</h3>
      <div class="row">
        <button type="button" data-source="camera" class="primary">📷 Scatta</button>
        <button type="button" data-source="gallery">🖼️ Galleria</button>
      </div>
      <button value="" class="cancel">Annulla</button>
    </form></dialog>
    <dialog id="newItem"><form method="dialog">
      <h3 id="newTitle"></h3>
      <div class="preview" id="newPreview"></div>
      <input type="text" id="newLabel" placeholder="Descrizione (opzionale)" autocomplete="off">
      <div class="row">
        <button value="school" class="primary">🏫 A scuola</button>
        <button value="home">🏠 A casa</button>
      </div>
      <button value="" class="cancel">Annulla</button>
    </form></dialog>
    <input type="file" id="camera" accept="image/*" capture="environment" hidden>
    <input type="file" id="gallery" accept="image/*" multiple hidden>`
  document.body.append(...wrap.children)
  const $ = (id) => document.getElementById(id)
  dom = { source: $('source'), newItem: $('newItem'), title: $('newTitle'), preview: $('newPreview'), label: $('newLabel') }
  // Click the input inside the same tap, so the browser lets the picker open.
  dom.source.addEventListener('click', (e) => {
    const b = e.target.closest('[data-source]')
    if (!b) return
    dom.source.close()
    $(b.dataset.source).click()
  })
  // Camera (capture opens the rear camera directly) and gallery (multi-select) share one handler.
  for (const id of ['camera', 'gallery']) $(id).addEventListener('change', (e) => {
    const files = [...e.target.files]; e.target.value = ''
    filesHandler(files)
  })
  return dom
}

/** Prepare the DOM early so the first tap on "Aggiungi" is not delayed. */
export function initDialogs() { ensureDom() }

export function openSourcePicker() { ensureDom().source.showModal() }

/**
 * Ask where new photos go and an optional description.
 * @param {string[]} previewUrls
 * @param {string} tabName
 * @returns {Promise<{location: 'school'|'home', label: string}|null>} null if cancelled
 */
export function askNewItem(previewUrls, tabName) {
  const { newItem: dlg, title, preview, label } = ensureDom()
  const n = previewUrls.length
  title.textContent = n === 1 ? `Nuovo capo · ${tabName}` : `${n} nuovi capi · ${tabName}`
  preview.replaceChildren(...previewUrls.map((src) => Object.assign(document.createElement('img'), { src, alt: '' })))
  label.value = ''
  // Several photos: one description would be wrong for all of them, so skip it.
  label.hidden = n > 1
  dlg.returnValue = ''
  dlg.showModal()
  return new Promise((resolve) => dlg.addEventListener('close', () =>
    resolve(dlg.returnValue ? { location: dlg.returnValue, label: label.hidden ? '' : label.value.trim() } : null), { once: true }))
}

/** Single place where a failed action reaches the user. */
export function reportError(e) {
  if (e?.name === 'QuotaExceededError') alert('Memoria del telefono piena: esporta un backup ed elimina qualche capo.')
  else alert('Operazione non riuscita: ' + (e?.message ?? e))
}
