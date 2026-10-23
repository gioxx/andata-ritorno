// Photo helpers: decode, compress to a Blob, and convert legacy data URLs.

/** @typedef {import('./types.js').Photo} Photo */

/** Validate that a blob is a decodable image and report its size. */
export async function decodeImage(blob) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    throw new Error('not-an-image');
  }
  const { width, height } = bitmap;
  bitmap.close();
  return { width, height };
}

const toBlob = (canvas, type, quality) =>
  new Promise((resolve) => canvas.toBlob(resolve, type, quality));

/** Resize to `max` px on the long side and encode as WebP (JPEG fallback). */
export async function compress(file, { max = 1600, quality = 0.85 } = {}) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error('not-an-image');
  }
  try {
    const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);
    let blob = await toBlob(canvas, 'image/webp', quality);
    // Safari can't encode WebP and silently returns PNG (huge): fall back to JPEG.
    if (!blob || blob.type !== 'image/webp') blob = await toBlob(canvas, 'image/jpeg', quality);
    if (!blob) throw new Error('encode-failed');
    return { id: crypto.randomUUID(), blob, width, height };
  } finally {
    bitmap.close();
  }
}

/** Decode a base64 image data URL to a Blob without re-encoding. */
export function dataUrlToBlob(dataUrl) {
  const m = /^data:(image\/[a-z0-9.+-]+);base64,(.*)$/is.exec(dataUrl);
  if (!m) throw new Error('bad-data-url');
  const bin = atob(m[2]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: m[1].toLowerCase() });
}

/** Compress many files; non-images and failures are counted, never thrown. */
export async function compressAll(files, compressFn = compress) {
  const photos = [];
  let skipped = 0;
  for (const file of files) {
    if (!file.type?.startsWith('image/')) { skipped++; continue; }
    try {
      photos.push(await compressFn(file));
    } catch {
      skipped++;
    }
  }
  return { photos, skipped };
}
