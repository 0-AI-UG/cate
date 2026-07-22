import { describe, expect, it } from 'vitest'
import { isFileDrag } from './fileDropTarget'
import { CATE_FILE_MIME, CATE_FILES_MIME, CHAT_DRAG_MIME } from './fileDragPayload'

// isFileDrag is the whitelist behind the shared <FileDropOverlay> highlight AND
// the capture-phase preventDefault that lets a drop land. A dragged chat must
// count so the canvas / dock zones light up (and accept the drop) like a file drag.
function evt(types: string[] | undefined): DragEvent {
  return { dataTransfer: types ? { types } : undefined } as unknown as DragEvent
}

describe('isFileDrag', () => {
  it('accepts Cate file, multi-file, OS-file, and chat drags', () => {
    expect(isFileDrag(evt([CATE_FILE_MIME]))).toBe(true)
    expect(isFileDrag(evt([CATE_FILES_MIME]))).toBe(true)
    expect(isFileDrag(evt(['Files']))).toBe(true)
    expect(isFileDrag(evt([CHAT_DRAG_MIME]))).toBe(true)
  })

  it('ignores unrelated drags and a missing dataTransfer', () => {
    expect(isFileDrag(evt(['text/plain']))).toBe(false)
    expect(isFileDrag(evt(undefined))).toBe(false)
  })
})
