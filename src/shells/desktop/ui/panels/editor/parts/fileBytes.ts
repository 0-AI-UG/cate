// Pure byte helpers for the preview viewers: type detection by magic bytes and
// safe buffer extraction. Kept out of React so they test without jsdom.

import type { DocumentType } from '@workspace/files/contract'

export interface DetectedType {
  documentType: DocumentType
  mimeType: string
}

const startsWith = (bytes: Uint8Array, ...values: number[]) => values.every((value, i) => bytes[i] === value)

/** The document type the bytes say they are; null when unknown. */
export function detectTypeFromBytes(bytes: Uint8Array): DetectedType | null {
  if (bytes.length < 4) return null
  if (startsWith(bytes, 0x25, 0x50, 0x44, 0x46)) return { documentType: 'pdf', mimeType: 'application/pdf' }
  if (startsWith(bytes, 0xff, 0xd8, 0xff)) return { documentType: 'image', mimeType: 'image/jpeg' }
  if (startsWith(bytes, 0x89, 0x50, 0x4e, 0x47)) return { documentType: 'image', mimeType: 'image/png' }
  if (startsWith(bytes, 0x47, 0x49, 0x46, 0x38)) return { documentType: 'image', mimeType: 'image/gif' }
  if (bytes.length >= 12 && startsWith(bytes, 0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return { documentType: 'image', mimeType: 'image/webp' }
  }
  if (startsWith(bytes, 0x42, 0x4d)) return { documentType: 'image', mimeType: 'image/bmp' }
  if (startsWith(bytes, 0x49, 0x49, 0x2a, 0x00) || startsWith(bytes, 0x4d, 0x4d, 0x00, 0x2a)) {
    return { documentType: 'image', mimeType: 'image/tiff' }
  }
  if (startsWith(bytes, 0x00, 0x00, 0x01, 0x00)) return { documentType: 'image', mimeType: 'image/x-icon' }
  const head = new TextDecoder('utf-8', { fatal: false }).decode(bytes.slice(0, 256))
  if (head.includes('<svg')) return { documentType: 'image', mimeType: 'image/svg+xml' }
  // DOCX is a zip with a word/ entry near the start.
  if (startsWith(bytes, 0x50, 0x4b, 0x03, 0x04) && new TextDecoder('utf-8', { fatal: false }).decode(bytes.slice(0, 2000)).includes('word/')) {
    return { documentType: 'docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }
  }
  return null
}

/** A standalone ArrayBuffer of exactly the viewed bytes. A Uint8Array can be
 *  a window onto a larger buffer; handing its `.buffer` to mammoth would feed
 *  it the neighbouring bytes too. */
export function viewedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return (bytes.buffer as ArrayBuffer).slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  return btoa(binary)
}
