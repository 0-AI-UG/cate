// =============================================================================
// Pure byte helpers for FilePreview viewers. Kept out of the React module
// so they can be unit-tested without jsdom/pdfjs/mammoth.
// =============================================================================

/** Extract a standalone ArrayBuffer covering exactly the bytes a Uint8Array
 *  views. A Uint8Array can be a window onto a larger buffer (non-zero
 *  byteOffset, shorter byteLength); handing its raw `.buffer` to mammoth would
 *  feed it the neighbouring bytes too, corrupting the document. This slices to
 *  the viewed region so the consumer sees only the file's bytes. */
export function viewedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return (bytes.buffer as ArrayBuffer).slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  )
}
