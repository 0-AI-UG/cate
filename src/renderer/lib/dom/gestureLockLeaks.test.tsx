// =============================================================================
// Regression cover for the three ways a `canvas-interacting` reference could be
// orphaned. Each one strands the lock permanently — no remount, workspace
// switch, or click can clear it, because only the (now unreachable) owner can
// release its own reference. Symptom set: panels stop scrolling, the canvas
// stops panning, click-to-focus stops working, while edge/dock resize keeps
// working because the resize strips are outside the panel and ungated.
// =============================================================================

import React from 'react'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { bodyClassRefCount, forceResetBodyClass } from './bodyClassRefcount'
import { applyBodyClassEffect } from '../../drag/types'
import DockResizeHandle from '../../docking/DockResizeHandle'

const LOCK = 'canvas-interacting'

// React 18 wants this flag before act() drives a concurrent root.
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  forceResetBodyClass(LOCK)
  container = document.createElement('div')
  document.body.appendChild(container)
  act(() => {
    root = createRoot(container)
  })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  forceResetBodyClass(LOCK)
})

describe('drag runtime body-class effects', () => {
  it('refcounts instead of writing the class raw', () => {
    // A raw classList.add left the class on <body> at refcount 0, where no
    // release could ever reach it; a raw remove stripped it out from under a
    // concurrent resize. Both directions must go through the refcount.
    applyBodyClassEffect({ cls: LOCK, on: true })
    expect(bodyClassRefCount(LOCK)).toBe(1)
    expect(document.body.classList.contains(LOCK)).toBe(true)

    applyBodyClassEffect({ cls: LOCK, on: false })
    expect(bodyClassRefCount(LOCK)).toBe(0)
    expect(document.body.classList.contains(LOCK)).toBe(false)
  })

  it('does not strip the class out from under another live owner', () => {
    // A resize is holding the lock when a drag ends. The raw remove used to
    // clear the class while the resize still needed it.
    applyBodyClassEffect({ cls: LOCK, on: true }) // resize-ish holder
    applyBodyClassEffect({ cls: LOCK, on: true }) // drag START
    applyBodyClassEffect({ cls: LOCK, on: false }) // drag END

    expect(bodyClassRefCount(LOCK)).toBe(1)
    expect(document.body.classList.contains(LOCK)).toBe(true)
  })
})

describe('DockResizeHandle', () => {
  const press = (el: HTMLElement, x: number) =>
    act(() => {
      el.dispatchEvent(new MouseEvent('mousedown', { button: 0, clientX: x, bubbles: true }))
    })

  function renderHandle() {
    act(() => {
      root.render(<DockResizeHandle direction="horizontal" onResize={() => {}} />)
    })
    return container.firstElementChild as HTMLElement
  }

  it('releases the previous pin when a second press arrives mid-drag', () => {
    const handle = renderHandle()

    press(handle, 100)
    expect(bodyClassRefCount(LOCK)).toBe(1)

    // The second press aborts the first gesture's listeners, so its endDrag
    // never runs — the first pin's release closure is unreachable from here on.
    press(handle, 140)
    expect(bodyClassRefCount(LOCK)).toBe(1)

    act(() => {
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    })
    expect(bodyClassRefCount(LOCK)).toBe(0)
    expect(document.body.classList.contains(LOCK)).toBe(false)
  })
})
