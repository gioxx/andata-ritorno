// Export: build the v2 ZIP, hand it to the share sheet (Android) or download it.
import { loadAll, getPhoto, getMeta, setMeta } from '../db.js'
import { buildZip } from './zip.js'
import { getFamily, kitOf } from '../sync/family.js'
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
 * Record a backup: lastBackupAt = now, and the unsaved counter loses the `saved` changes the
 * backup contains (changes made after it stay counted). Run it in the mutation queue.
 * @param {number} saved the unsaved counter when the backup was built
 */
export async function markBackupDone(db, now, saved) {
  const current = (await getMeta(db, 'unsavedCount')) ?? 0
  await setMeta(db, 'lastBackupAt', now.toISOString())
  await setMeta(db, 'unsavedCount', Math.max(0, current - saved))
}

/** The kit of the family this phone is in, if it has one yet (an invited phone gets it by sync). */
async function familyKitOf(db) {
  const meta = await getFamily(db)
  if (!meta || meta.pending) return null
  try { return kitOf(meta) } catch { return null }
}

/**
 * Side effects are injectable for tests. Meta is only touched once the file surely reached the
 * user (shared). A download gives the page no answer: the caller asks, then calls markBackupDone.
 * @returns {Promise<'shared'|'downloaded'|'cancelled'>}
 */
export async function exportBackup(db, { share = defaultShare, download = defaultDownload, now = new Date() } = {}) {
  const saved = (await getMeta(db, 'unsavedCount')) ?? 0
  const { tabs, items, categories } = await loadAll(db)
  const blob = await buildZip({ tabs, items, categories, getPhoto: (id) => getPhoto(db, id), now, familyKit: await familyKitOf(db) })
  const name = backupFileName(now)
  const file = new File([blob], name, { type: 'application/zip' })

  try {
    if (!(await share(file))) { download(file); return 'downloaded' }
  } catch (e) {
    if (e?.name === 'AbortError') return 'cancelled' // user closed the share sheet
    // Android Chrome refuses to share some file types (NotAllowedError): save to Downloads instead.
    download(file)
    return 'downloaded'
  }
  await markBackupDone(db, now, saved)
  return 'shared'
}
