// Erases everything A/R keeps on this device. Only the typed-confirmation flow may call it.
const PREFIX = 'ar-'

const defaultStorages = () => {
  const list = []
  for (const name of ['localStorage', 'sessionStorage']) {
    try { list.push(window[name]) } catch { /* blocked storage: nothing to clear there */ }
  }
  return list
}

/** Remove our own keys only; collect first, since removing while iterating shifts the indexes. */
function clearOwnKeys(storage) {
  try {
    const keys = []
    for (let i = 0; i < storage.length; i++) keys.push(storage.key(i))
    for (const k of keys) if (k?.startsWith(PREFIX)) storage.removeItem(k)
  } catch { /* best effort */ }
}

/**
 * Close our connection, delete the 'ar' database, then clear ar-* preferences.
 * Cache Storage and the service worker stay, so the app still works offline afterwards.
 * Storage is cleared only once the database is really gone.
 * @param {{ db: any, deleteDatabase?: (name: string) => IDBOpenDBRequest, storages?: Storage[] }} opts
 */
export async function wipeAll({ db, deleteDatabase = (name) => indexedDB.deleteDatabase(name), storages = defaultStorages() }) {
  db.close() // an open connection would block the delete forever
  await new Promise((resolve, reject) => {
    const req = deleteDatabase('ar')
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
    // Other tabs are asked to close (they reload on versionchange); the request completes then.
    req.onblocked = () => {}
  })
  for (const s of storages) clearOwnKeys(s)
}
