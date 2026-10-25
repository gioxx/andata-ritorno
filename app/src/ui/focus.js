// Focus helpers shared by the screen and the dialogs. Screens are redrawn with innerHTML, so a
// focused element is remembered as a selector ("locator") and found again after the redraw.

// Attributes that identify an element across redraws.
const KEYS = ['id', 'data-id', 'data-act', 'data-view', 'data-tab', 'data-tag', 'data-tagclear', 'data-section', 'data-menu',
  'data-theme-choice', 'data-lang-choice', 'data-cat', 'data-cat-act', 'data-source', 'data-done', 'data-v', 'data-child']
const q = (v) => String(v).replace(/["\\]/g, '\\$&')
const attrSel = (el) => KEYS.filter((k) => el.hasAttribute(k)).map((k) => `[${k}="${q(el.getAttribute(k))}"]`).join('')

/** A selector that finds an equivalent of `el` after its container is redrawn; '' if none can be built. */
export function locator(el) {
  if (!el || el === document.body || !el.localName) return ''
  const own = attrSel(el)
  if (own && el.id) return own
  let anchor = ''
  for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
    const a = ['id', 'data-id'].map((k) => (n.hasAttribute(k) ? `[${k}="${q(n.getAttribute(k))}"]` : '')).join('')
    if (a) { anchor = a + ' '; break }
  }
  const cls = el.classList[0] ? `.${CSS_ident(el.classList[0])}` : ''
  return anchor + el.localName + (own || cls)
}
const CSS_ident = (s) => String(s).replace(/[^\w-]/g, '\\$&')

/** The live element a locator (or the element itself, if still in the page) points to. */
export function resolve(target) {
  if (!target) return null
  if (typeof target !== 'string') {
    if (target.isConnected) return target
    target = locator(target)
  }
  try { return target ? document.querySelector(target) : null } catch { return null }
}

/** Run `fn` (which redraws `container`) and put focus back on the equivalent element. */
export function keepFocus(container, fn) {
  const a = document.activeElement
  const loc = a && a !== document.body && container.contains(a) ? locator(a) : ''
  const out = fn()
  if (loc) {
    const el = container.querySelector(loc)
    if (el && !el.disabled) el.focus({ preventScroll: true })
  }
  return out
}

let activator = null
/** The control the user last pressed: Safari does not focus buttons on tap, so activeElement alone is not enough. */
export const noteActivator = (el) => { activator = el ? { el, loc: locator(el) } : null }
export const lastActivator = () => (activator ? resolve(activator.el) ?? resolve(activator.loc) : null)
