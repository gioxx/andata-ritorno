// Add flow: camera / gallery / clipboard -> compress -> ask location -> save.
import { compressAll } from '../photos.js'
import { store, addPhotos } from '../store.js'
import { recheckClipboard } from './clipboard.js'
import { hooks } from './render.js'
import { initDialogs, setFilesHandler, openSourcePicker, askNewItem, reportError } from './dialogs.js'
import { t } from '../i18n.js'

let busy = false // one add dialog at a time
/** True from picking photos until saved or cancelled (an update reload would lose them). */
export const isAdding = () => busy

/** Add image files/blobs as new items for the current tab. Resolves false if there was nothing to add. */
async function addFiles(files) {
  if (!files.length) return false
  if (busy) { alert(t('add.busy')); return true }
  busy = true
  let urls = []
  try {
    const { photos, skipped } = await compressAll(files)
    if (skipped) alert(t('add.skipped', { n: skipped }))
    if (!photos.length) return true
    urls = photos.map((p) => URL.createObjectURL(p.blob))
    const tabName = store.tabs.find((t) => t.id === store.currentTabId)?.name ?? ''
    const choice = await askNewItem(urls, tabName)
    if (choice) await addPhotos(photos, choice)
    return true
  } finally {
    for (const u of urls) URL.revokeObjectURL(u)
    busy = false
  }
}

const addFilesSafe = (files) => addFiles(files).catch(reportError)

// Paste an image copied elsewhere (e.g. Google Keep: long-press photo, Copy).
async function pasteFromClipboard() {
  if (!navigator.clipboard?.read) return alert(t('add.pasteUnsupported'))
  const files = []
  try {
    for (const item of await navigator.clipboard.read()) {
      const type = item.types.find((t) => t.startsWith('image/'))
      if (type) files.push(new File([await item.getType(type)], 'incollata', { type }))
    }
  } catch (e) {
    return alert(e.name === 'NotAllowedError'
      ? t('add.clipboardDenied')
      : t('add.pasteFailed', { message: e.message }))
  }
  if (!await addFiles(files)) {
    alert(t('add.noImage'))
    recheckClipboard()
  }
}

export function initAddFlow() {
  initDialogs()
  setFilesHandler(addFilesSafe)
  hooks.onAdd = openSourcePicker
  hooks.onPaste = pasteFromClipboard
  // Keyboard / context-menu paste (desktop, or Android when a paste event fires).
  document.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])]
    if (files.length) { e.preventDefault(); addFilesSafe(files) }
  })
}
