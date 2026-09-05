import { describe, expect, it } from 'vitest'
import { isFileDrag } from './fileDropTarget'
import { CATE_FILE_MIME, CATE_FILES_MIME } from './fileDragPayload'
function evt(types: string[] | undefined): DragEvent {
  return { dataTransfer: types ? { types } : undefined } as unknown as DragEvent
}

describe('isFileDrag', () => {
  it('accepts Cate file, multi-file, and OS-file drags', () => {
    expect(isFileDrag(evt([CATE_FILE_MIME]))).toBe(true)
    expect(isFileDrag(evt([CATE_FILES_MIME]))).toBe(true)
    expect(isFileDrag(evt(['Files']))).toBe(true)
  })

  it('ignores unrelated drags and a missing dataTransfer', () => {
    expect(isFileDrag(evt(['text/plain']))).toBe(false)
    expect(isFileDrag(evt(undefined))).toBe(false)
  })
})
