// Pure zoom/pan/swipe math for the viewer. The image fills the stage with object-fit:contain
// and is transformed around the stage centre, so all points are relative to that centre.

export const MIN_SCALE = 1
export const MAX_SCALE = 5
export const DOUBLE_TAP_SCALE = 2.5
const SWIPE_X = 60
const SWIPE_DOWN = 80

export const clampScale = (s) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s))

/** Size of an image of `iw`x`ih` shown with object-fit:contain in a `vw`x`vh` box. */
export function containSize(vw, vh, iw, ih) {
  if (!iw || !ih) return { w: vw, h: vh }
  const r = Math.min(vw / iw, vh / ih)
  return { w: iw * r, h: ih * r }
}

/** Keep the zoomed image covering the stage: pan is limited to what overflows it. */
export function clampPan(x, y, scale, vp, content) {
  const mx = Math.max(0, (content.w * scale - vp.w) / 2)
  const my = Math.max(0, (content.h * scale - vp.h) / 2)
  return { x: Math.min(mx, Math.max(-mx, x)), y: Math.min(my, Math.max(-my, y)) }
}

/** Re-fit a transform after the stage or image size changed: scale stays in range, pan stays covered. */
export function refit(tf, vp, content) {
  const s = clampScale(tf.s)
  return { s, ...clampPan(tf.x, tf.y, s, vp, content) }
}

/**
 * New transform when the gesture midpoint moves `from` -> `to` and the pinch distance is
 * multiplied by `ratio`; the content point under `from` ends up under `to`.
 * A double tap is the special case from === to.
 * @param {{s:number,x:number,y:number}} start
 */
export function pinch(start, from, to, ratio, vp, content) {
  const s = clampScale(start.s * ratio)
  const k = s / start.s
  const x = to.x - (from.x - start.x) * k
  const y = to.y - (from.y - start.y) * k
  return { s, ...clampPan(x, y, s, vp, content) }
}

/** What a finished one-finger drag means. Only at 1x: zoomed in, drags pan instead. */
export function swipeIntent(dx, dy, scale) {
  if (scale > MIN_SCALE) return null
  if (Math.abs(dx) >= SWIPE_X && Math.abs(dx) > Math.abs(dy)) return dx < 0 ? 'next' : 'prev'
  if (dy >= SWIPE_DOWN && dy > Math.abs(dx)) return 'close'
  return null
}

/** Next index inside [0, n) or null at the ends (no wrap-around). */
export function stepIndex(i, dir, n) {
  const j = dir === 'next' ? i + 1 : i - 1
  return j >= 0 && j < n ? j : null
}
