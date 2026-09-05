import { describe, expect, it, vi } from 'vitest'
import {
  CATE_FILE_LINE_MIME,
  CATE_FILE_MIME,
  CATE_FILES_MIME,
  hasCateFileDrag,
  readCateFileLocation,
  readCateFilePaths,
  writeCateFileDrag,
} from './fileDragPayload'

function transfer(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  return {
    data,
    setData: vi.fn((type: string, value: string) => data.set(type, value)),
    getData: vi.fn((type: string) => data.get(type) ?? ''),
  }
}

describe('Cate file drag payload', () => {
  it('writes and reads multi-file and line-location payloads', () => {
    const dt = transfer()
    writeCateFileDrag(dt, ['/a.ts', '/b.ts'], { path: '/a.ts', line: 12, column: 4 })

    expect(dt.data.get(CATE_FILE_MIME)).toBe('/a.ts')
    expect(dt.data.get(CATE_FILES_MIME)).toBe('["/a.ts","/b.ts"]')
    expect(readCateFilePaths(dt)).toEqual(['/a.ts', '/b.ts'])
    expect(readCateFileLocation(dt)).toEqual({ path: '/a.ts', line: 12, column: 4 })
  })

  it('falls back to the single-file payload and tolerates malformed optional data', () => {
    const dt = transfer({
      [CATE_FILE_MIME]: '/single.ts',
      [CATE_FILES_MIME]: '{broken',
      [CATE_FILE_LINE_MIME]: JSON.stringify({ path: '/single.ts', line: 2 }),
    })

    expect(readCateFilePaths(dt)).toEqual(['/single.ts'])
    expect(readCateFileLocation(dt)).toEqual({ path: '/single.ts', line: 2, column: 1 })
    dt.data.set(CATE_FILE_LINE_MIME, JSON.stringify({ path: 42, line: 'bad' }))
    expect(readCateFileLocation(dt)).toBeNull()
  })

  it('detects Cate file payload types and ignores empty writes', () => {
    expect(hasCateFileDrag({ types: [CATE_FILES_MIME] })).toBe(true)
    expect(hasCateFileDrag({ types: ['text/plain'] })).toBe(false)
    expect(hasCateFileDrag(null)).toBe(false)

    const dt = transfer()
    writeCateFileDrag(dt, [])
    expect(dt.setData).not.toHaveBeenCalled()
  })
})
