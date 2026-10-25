// Export: build the v2 ZIP, hand it to the share sheet (Android) or download it.
import { loadAll, getPhoto, setMeta } from '../db.js'
import { buildZip } from './zip.js'
import { t } from '../i18n.js'

// iOS Safari 15+ shares ZIP files through the same API; if the gesture expired it throws and we download.
/** @returns {Promise<boolean>} false when sharing files is not supported */
async function defaultShare(file) {
  if (!navigator.canShare?.({ files: [file] })) return false
  await navigator.share({ files: [file], title: t('export.shareTitle') })
  return true
}

function defaultDownload(file) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(file)
  a.download = file.name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 10000)
}

/** Deterministic, so the UI can tell the user where the download landed. */
export const backupFileName = (now) => `andata-ritorno-${now.toISOString().slice(0, 10)}.zip`

/**
 * Side effects are injectable for tests. Meta is only touched on success.
 * @returns {Promise<'shared'|'downloaded'|'cancelled'>}
 */
export async function exportBackup(db, { share = defaultShare, download = defaultDownload, now = new Date() } = {}) {
  const { tabs, items, categories } = await loadAll(db)
  const blob = await buildZip({ tabs, items, categories, getPhoto: (id) => getPhoto(db, id), now })
  const name = backupFileName(now)
  const file = new File([blob], name, { type: 'application/zip' })

  let result
  try {
    result = (await share(file)) ? 'shared' : (download(file), 'downloaded')
  } catch (e) {
    if (e?.name === 'AbortError') return 'cancelled' // user closed the share sheet
    // Android Chrome refuses to share some file types (NotAllowedError): save to Downloads instead.
    download(file)
    result = 'downloaded'
  }
  await setMeta(db, 'lastBackupAt', now.toISOString())
  await setMeta(db, 'unsavedCount', 0)
  return result
}
