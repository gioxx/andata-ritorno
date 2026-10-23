// Show "Incolla" only when the clipboard may hold an image. Before the first permission
// grant the state is unknown (null), so the button stays visible.
let hasImage = null

export function canShowPaste() {
  return !!navigator.clipboard?.read && hasImage !== false
}

async function check(onChange) {
  if (!navigator.clipboard?.read || !navigator.permissions) return
  const before = hasImage
  try {
    const { state } = await navigator.permissions.query({ name: 'clipboard-read' })
    if (state === 'denied') hasImage = false
    else if (state === 'granted') hasImage = (await navigator.clipboard.read()).some((i) => i.types.some((t) => t.startsWith('image/')))
    else hasImage = null
  } catch { hasImage = null } // e.g. document not focused, or permission name unsupported
  if (hasImage !== before) onChange()
}

let changed = () => {}
/** Re-check now (e.g. after a paste that found no image). */
export function recheckClipboard() {
  return check(changed)
}

/** Re-check when the app returns to the foreground. */
export function watchClipboard(onChange) {
  changed = onChange
  const run = () => check(onChange)
  window.addEventListener('focus', run)
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') run() })
  run()
}
