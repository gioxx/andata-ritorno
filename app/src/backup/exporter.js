// Export: build the v2 ZIP, hand it to the share sheet (Android) or download it.
import { loadAll, getPhoto, setMeta } from '../db.js'
import { buildZip } from './zip.js'

/** @returns {Promise<boolean>} false when sharing files is not supported */
async function defaultShare(file) {
  if (!navigator.canShare?.({ files: [file] })) return false
  await navigator.share({ files: [file], title: 'Backup Andata e Ritorno' })
  return true
}

function defaultDownload(file) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(file)
  a.download = file.name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 10000)
}

/**
 * Side effects are injectable for tests. Meta is only touched on success.
 * @returns {Promise<'shared'|'downloaded'|'cancelled'>}
 */
export async function exportBackup(db, { share = defaultShare, download = defaultDownload, now = new Date() } = {}) {
  const { tabs, items } = await loadAll(db)
  const blob = await buildZip({ tabs, items, getPhoto: (id) => getPhoto(db, id) })
  const name = `andata-ritorno-${now.toISOString().slice(0, 10)}.zip`
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
