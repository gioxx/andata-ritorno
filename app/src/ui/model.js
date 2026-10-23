// Pure helpers behind the menu and the import flow (no DOM, unit-tested).

/** "N capi · ultimo backup: <date>|mai" */
export function backupInfoLine(count, lastBackupAt) {
  const n = count === 1 ? '1 capo' : `${count} capi`
  const when = lastBackupAt ? new Date(lastBackupAt).toLocaleString('it-IT') : 'mai'
  return `${n} · ultimo backup: ${when}`
}

/** @param {boolean|null} persisted null = the browser cannot say (no line) */
export function persistLine(persisted) {
  if (persisted === null) return ''
  return persisted ? 'Memoria protetta ✓' : 'Memoria non protetta: fai backup spesso'
}

const CHILD_LABEL = (c) => c.charAt(0).toUpperCase() + c.slice(1)

/** One mapping row per v1 child: default "new tab", then every existing tab. */
export function mappingRows(children, tabs) {
  return children.map((child) => ({
    child,
    options: [{ value: 'new', label: `Nuova scheda "${CHILD_LABEL(child)}"` }, ...tabs.map((t) => ({ value: t.id, label: t.name }))],
  }))
}

/** User-facing text for an import error; null = not an import error (use the generic handler). */
export function importErrorMessage(e) {
  switch (e?.message) {
    case 'quota': return 'Memoria del telefono piena: impossibile importare. Libera spazio e riprova.'
    case 'verify-failed': return "Verifica non riuscita dopo l'import: non cancellare nulla dalla vecchia app e riprova l'import."
    case 'bad-file': return 'File non valido'
  }
  // Corrupt JSON/ZIP surfaces as parser errors: all mean "not a backup we can read".
  if (e instanceof SyntaxError || e?.name === 'SyntaxError') return 'File non valido'
  return null
}

/** Drop one "Da rifare" entry (identified by itemId + reason). */
export function removeTodo(list, entry) {
  return list.filter((f) => !(f.itemId === entry.itemId && f.reason === entry.reason))
}

/** "N capi non si possono importare" */
export const blockedTitle = (n) => (n === 1 ? '1 capo non si può importare' : `${n} capi non si possono importare`)
