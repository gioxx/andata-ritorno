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

export const childLabel = (c) => c.charAt(0).toUpperCase() + c.slice(1)
const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]))

/** One mapping row per v1 child: default "new tab", then every existing tab. */
export function mappingRows(children, tabs) {
  return children.map((child) => ({
    child,
    label: childLabel(child),
    options: [{ value: 'new', label: `Nuova scheda "${childLabel(child)}"` }, ...tabs.map((t) => ({ value: t.id, label: t.name }))],
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

/** Drop the tapped "Da rifare" entry by position (id-less entries can look identical). */
export function removeTodo(list, index) {
  return list.filter((_, i) => i !== index)
}

const PLACE = { school: 'a scuola', home: 'a casa' }

/** Readable parts of a failure; empty parts are skipped. */
export function failureParts(f) {
  return {
    title: f.label || 'senza nome',
    detail: [f.tabName, PLACE[f.location] ?? f.location, f.reason].filter(Boolean).join(' · '),
  }
}

/** <li> for a failure list; `extra` is trusted markup appended inside (e.g. a button). */
export function failureRow(f, extra = '') {
  const { title, detail } = failureParts(f)
  return `<li><div><strong>${esc(title)}</strong><br><span>${esc(detail)}</span></div>${extra}</li>`
}

/**
 * A tapped button value is only final once confirmed. 'secondary' (partial import) needs the
 * user's yes; returns undefined when declined so the dialog stays open and nothing is chosen.
 */
export function confirmedChoice(choice, confirmFn) {
  if (choice === 'secondary' && !confirmFn()) return undefined
  return choice
}

/** "N capi non si possono importare" */
export const blockedTitle = (n) => (n === 1 ? '1 capo non si può importare' : `${n} capi non si possono importare`)
