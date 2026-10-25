// Lossless-geometry photo rotation: decode once, draw rotated at full size, encode once.

/** @typedef {import('./types.js').Photo} Photo */

/** Quarter turns clockwise, normalised to 0..3 (negatives wrap). */
export const normTurns = (n) => ((Math.round(n) % 4) + 4) % 4

const toBlob = (canvas, type, quality) =>
  new Promise((resolve) => canvas.toBlob(resolve, type, quality))

/** WebP q 0.92, JPEG fallback (Safari silently returns PNG for WebP, same rule as compress). */
export async function canvasEncode(canvas) {
  let blob = await toBlob(canvas, 'image/webp', 0.92)
  if (!blob || blob.type !== 'image/webp') blob = await toBlob(canvas, 'image/jpeg', 0.92)
  if (!blob) throw new Error('encode-failed')
  return blob
}

/**
 * Rotate a stored photo clockwise. Never downscales; a single re-encode.
 * @param {Blob} blob
 * @param {number} turns quarter turns clockwise (1..3)
 * @param {(canvas: HTMLCanvasElement) => Promise<Blob>} [encode]
 * @returns {Promise<Photo>} a new photo (new id) with the rotated dimensions
 */
export async function rotatePhoto(blob, turns, encode = canvasEncode) {
  const n = normTurns(turns)
  if (n === 0) throw new Error('no-rotation')
  let bitmap
  try {
    bitmap = await createImageBitmap(blob)
  } catch {
    throw new Error('not-an-image')
  }
  try {
    const { width: w, height: h } = bitmap
    const swap = n % 2 === 1
    const canvas = document.createElement('canvas')
    canvas.width = swap ? h : w
    canvas.height = swap ? w : h
    const ctx = canvas.getContext('2d')
    ctx.translate(canvas.width / 2, canvas.height / 2)
    ctx.rotate((n * Math.PI) / 2)
    ctx.drawImage(bitmap, -w / 2, -h / 2)
    const out = await encode(canvas)
    return { id: crypto.randomUUID(), blob: out, width: canvas.width, height: canvas.height }
  } finally {
    bitmap.close?.()
  }
}
