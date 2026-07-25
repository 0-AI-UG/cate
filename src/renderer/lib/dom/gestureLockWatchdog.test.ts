// @vitest-environment jsdom
// =============================================================================
// The gesture lock (`canvas-interacting`) is refcounted, and only the owner that
// acquired a reference can release it. When an owner's release closure is
// orphaned the lock is stranded FOREVER: it survives every React remount and
// workspace switch, kills pointer events on webview/monaco/xterm, and makes
// useDragOp refuse every drag. Before the watchdog, an app restart was the only
// cure. These lock the recovery path.
// =============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  acquireBodyClass,
  bodyClassRefCount,
  forceResetBodyClass,
} from './bodyClassRefcount'
import { installGestureLockWatchdog, IDLE_GRACE_MS } from './gestureLockWatchdog'

const LOCK = 'canvas-interacting'

let uninstall: () => void
let reports: { message: string; owners: string[] }[]

beforeEach(() => {
  vi.useFakeTimers()
  forceResetBodyClass(LOCK)
  reports = []
  uninstall = installGestureLockWatchdog((message, owners) => {
    reports.push({ message, owners })
  })
})

afterEach(() => {
  uninstall()
  forceResetBodyClass(LOCK)
  vi.useRealTimers()
})

const mouse = (type: string, buttons: number) =>
  window.dispatchEvent(new MouseEvent(type, { buttons, bubbles: true }))

describe('gestureLockWatchdog', () => {
  it('force-releases a lock stranded with no button held, and names the owner', () => {
    acquireBodyClass(LOCK, 'dock-resize-handle')
    expect(document.body.classList.contains(LOCK)).toBe(true)

    // The gesture "ends" — button up — but the owner never released.
    mouse('mouseup', 0)
    vi.advanceTimersByTime(IDLE_GRACE_MS + 50)

    expect(bodyClassRefCount(LOCK)).toBe(0)
    expect(document.body.classList.contains(LOCK)).toBe(false)
    expect(reports).toHaveLength(1)
    expect(reports[0].owners).toEqual(['dock-resize-handle'])
  })

  it('leaves a legitimate in-flight gesture alone while a button is held', () => {
    mouse('mousedown', 1)
    acquireBodyClass(LOCK, 'canvas-pan-drag')

    vi.advanceTimersByTime(IDLE_GRACE_MS * 5)
    // Moves during the drag keep reporting the held button.
    mouse('mousemove', 1)
    vi.advanceTimersByTime(IDLE_GRACE_MS * 5)

    expect(bodyClassRefCount(LOCK)).toBe(1)
    expect(document.body.classList.contains(LOCK)).toBe(true)
    expect(reports).toHaveLength(0)
  })

  it('does not fire on a wheel-pan that releases within the grace window', () => {
    acquireBodyClass(LOCK, 'canvas-wheel-pan')
    mouse('mousemove', 0)
    // The wheel-pan quiet timer (150ms) is well inside IDLE_GRACE_MS.
    vi.advanceTimersByTime(200)
    forceResetBodyClass(LOCK) // stand-in for the owner's own release
    vi.advanceTimersByTime(IDLE_GRACE_MS * 2)

    expect(reports).toHaveLength(0)
  })

  it('recovers a class written raw, outside the refcount entirely', () => {
    // Backstop for any writer that still bypasses acquireBodyClass: the class
    // is on <body> with no reference behind it, so nothing can ever release it.
    document.body.classList.add(LOCK)
    mouse('mouseup', 0)
    vi.advanceTimersByTime(IDLE_GRACE_MS + 50)

    expect(document.body.classList.contains(LOCK)).toBe(false)
    expect(reports[0].owners).toEqual(['<raw classList write>'])
  })

  it('recovers even when the wedge predates any further mouse activity', () => {
    acquireBodyClass(LOCK, 'drag-runtime')
    // No mouseup ever arrives (that is the bug); the first idle move re-checks.
    mouse('mousemove', 0)
    vi.advanceTimersByTime(IDLE_GRACE_MS + 50)

    expect(document.body.classList.contains(LOCK)).toBe(false)
    expect(reports[0].owners).toEqual(['drag-runtime'])
  })
})
