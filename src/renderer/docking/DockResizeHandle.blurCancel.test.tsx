// =============================================================================
// DockResizeHandle — blur cancellation.
//
// A dock-divider drag pins a document-wide `cursor: … !important` override (via
// pinDocumentCursor) for the drag duration and only tears it down on the
// `document` mouseup. But a macOS Spaces swipe or Cmd+Tab away mid-drag fires a
// window `blur` with NO mouseup, so the drag stays "live" and the pinned cursor
// leaks onto the whole document — the OS cursor then stays stuck (invisible /
// wrong shape) until the next click fires the stale mouseup. This pins the
// window-blur teardown that closes that gap.
//
// Driven through real DOM events, mirroring gestureBlurCancel.test.tsx.
// =============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import DockResizeHandle from './DockResizeHandle'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  act(() => {
    root = createRoot(container)
  })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.classList.remove('canvas-interacting')
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
})

/** The `!important` cursor override pinned by pinDocumentCursor, if present. */
function hasPinnedCursor(): boolean {
  return Array.from(document.head.querySelectorAll('style')).some((el) =>
    (el.textContent ?? '').includes('cursor: col-resize !important'),
  )
}

function renderHandle(onResize: (delta: number) => void): HTMLElement {
  act(() => root.render(<DockResizeHandle direction="horizontal" onResize={onResize} />))
  const handle = container.firstElementChild as HTMLElement | null
  if (!handle) throw new Error('handle not rendered')
  return handle
}

describe('DockResizeHandle — blur cancellation', () => {
  it('unpins the document cursor when the window blurs mid-drag (Spaces swipe / Cmd+Tab)', () => {
    const onResize = vi.fn()
    const handle = renderHandle(onResize)

    // Begin a horizontal divider drag.
    act(() => {
      handle.dispatchEvent(new MouseEvent('mousedown', { button: 0, clientX: 300, clientY: 200, bubbles: true }))
    })
    expect(document.body.style.cursor).toBe('col-resize')
    expect(document.body.classList.contains('canvas-interacting')).toBe(true)
    expect(hasPinnedCursor()).toBe(true)

    // A drag move resizes. The handle listens on `document`, so target it there.
    act(() => document.dispatchEvent(new MouseEvent('mousemove', { clientX: 340, clientY: 200, bubbles: true })))
    expect(onResize).toHaveBeenCalledWith(40)
    onResize.mockClear()

    // Swipe to another Space / Cmd+Tab away — window blur, no mouseup.
    act(() => window.dispatchEvent(new Event('blur')))

    // Cursor unpinned, body class released, no leftover pin <style>.
    expect(document.body.style.cursor).toBe('')
    expect(document.body.classList.contains('canvas-interacting')).toBe(false)
    expect(hasPinnedCursor()).toBe(false)

    // A stale mousemove after blur must NOT keep resizing.
    act(() => document.dispatchEvent(new MouseEvent('mousemove', { clientX: 900, clientY: 200, bubbles: true })))
    expect(onResize).not.toHaveBeenCalled()
  })
})
