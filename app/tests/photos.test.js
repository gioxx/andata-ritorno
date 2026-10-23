import { describe, it, expect } from 'vitest';
import { dataUrlToBlob, compressAll, decodeImage } from '../src/photos.js';

const B64 = 'UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==';
const bytesOf = async (b) => new Uint8Array(await b.arrayBuffer());

describe('photos', () => {
  it('dataUrlToBlob keeps bytes', async () => {
    const blob = dataUrlToBlob(`data:image/webp;base64,${B64}`);
    const expected = Uint8Array.from(atob(B64), (c) => c.charCodeAt(0));
    expect(blob.type).toBe('image/webp');
    expect(blob.size).toBe(expected.length);
    expect(await bytesOf(blob)).toEqual(expected);
  });

  it('dataUrlToBlob rejects text data URL', () => {
    expect(() => dataUrlToBlob('data:text/plain;base64,aGVsbG8=')).toThrow('bad-data-url');
  });

  it('decodeImage resolves size and rejects non-images', async () => {
    const ok = new Blob([new Uint8Array([1, 2])], { type: 'image/png' });
    expect(await decodeImage(ok)).toEqual({ width: 1, height: 1 });
    await expect(decodeImage(new Blob(['x'], { type: 'text/plain' }))).rejects.toThrow('not-an-image');
  });

  it('compressAll skips non-images', async () => {
    const pdf = new File([new Uint8Array([1])], 'a.pdf', { type: 'application/pdf' });
    const empty = new File([], 'e.jpg', { type: 'image/jpeg' });
    const good = new File([new Uint8Array([1, 2, 3])], 'g.jpg', { type: 'image/jpeg' });
    const fake = async (f) => {
      await decodeImage(f); // empty image rejects here, like the real compress
      return { id: 'p1', blob: f, width: 1, height: 1 };
    };
    const { photos, skipped } = await compressAll([pdf, empty, good], fake);
    expect(photos.length).toBe(1);
    expect(photos[0].id).toBe('p1');
    expect(skipped).toBe(2);
  });
});
