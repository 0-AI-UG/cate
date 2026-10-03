import { describe, expect, it } from 'vitest'
import { bytesToBase64, detectTypeFromBytes, viewedArrayBuffer } from './fileBytes'

describe('detectTypeFromBytes', () => {
  it('recognises documents and images by their magic bytes', () => {
    expect(detectTypeFromBytes(new TextEncoder().encode('%PDF-1.7'))?.documentType).toBe('pdf')
    expect(detectTypeFromBytes(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0]))?.mimeType).toBe('image/png')
    expect(detectTypeFromBytes(new TextEncoder().encode('<?xml version="1.0"?><svg/>'))?.mimeType).toBe('image/svg+xml')
    const docx = new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...new TextEncoder().encode('....word/document.xml')])
    expect(detectTypeFromBytes(docx)?.documentType).toBe('docx')
  })

  it('returns null for text and short input', () => {
    expect(detectTypeFromBytes(new TextEncoder().encode('hello world'))).toBeNull()
    expect(detectTypeFromBytes(new Uint8Array([1, 2]))).toBeNull()
  })
})

describe('viewedArrayBuffer', () => {
  it('copies only the viewed window of a larger buffer', () => {
    const backing = new Uint8Array([1, 2, 3, 4, 5, 6])
    const view = backing.subarray(2, 5)
    expect([...new Uint8Array(viewedArrayBuffer(view))]).toEqual([3, 4, 5])
  })
})

describe('bytesToBase64', () => {
  it('encodes bytes', () => {
    expect(bytesToBase64(new TextEncoder().encode('hi!'))).toBe('aGkh')
  })
})
