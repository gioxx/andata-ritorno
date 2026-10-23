import 'fake-indexeddb/auto';

// Node has no createImageBitmap: fake a 1x1 bitmap for non-empty image blobs.
globalThis.createImageBitmap = async (blob) => {
  if (blob?.type?.startsWith('image/') && blob.size > 0) {
    return { width: 1, height: 1, close() {} };
  }
  throw new Error('not-an-image');
};
