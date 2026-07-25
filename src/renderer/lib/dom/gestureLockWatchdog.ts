// =============================================================================
// gestureLockWatchdog — recovery net for a stranded `canvas-interacting` hold.
//
// Every owner of the gesture lock is a bounded gesture: either a mouse button is
// held (pan-drag, marquee, node drag, edge/dock resize) or a wheel-pan quiet
// timer is running (released ~150ms after the wheel stops). So OUTSIDE those two
// conditions the lock must not be held. If it still is, some owner's release
// closure was orphaned — a bug — and the app is wedged: `canvas-interacting`
// kills pointer events on webview/monaco/xterm (panels stop scrolling) and
// `useDragOp` refuses to start any drag. Nothing short of an app restart clears
// it, because only the (now unreachable) owner can release its own reference.
//
// The watchdog closes that: whenever the pointer goes idle it re-checks, and a
// hold that survives IDLE_GRACE_MS with no button down is force-released and
// reported with the owner labels so the underlying leak stays diagnosable.
//
// This is a net, not a substitute for balanced acquire/release. It fires only on
// a real bug, and it logs loudly when it does.
// =============================================================================

import {
  bodyClassOwners,
  bodyClassRefCount,
  forceResetBodyClass,
  oldestBodyClassRefAge,
} from './bodyClassRefcount'

const LOCK = 'canvas-interacting'

/** How long the lock may stay held with no button down before it counts as
 *  stranded. Comfortably longer than the 150ms wheel-pan quiet timer, short
 *  enough that a wedged app recovers within a second of the user noticing. */
export const IDLE_GRACE_MS = 1000

/** Re-check cadence while the pointer is idle and the lock is still held. */
const RECHECK_MS = 500

type Reporter = (message: string, owners: string[]) => void

let installed = false

/** Any mouse button currently held? A gesture-owned lock always has one down —
 *  except the wheel-pan, which the IDLE_GRACE_MS window covers. */
function buttonsDown(ev?: MouseEvent): boolean {
  return !!ev && ev.buttons !== 0
}

/**
 * Install the watchdog on `window`. Idempotent; returns a cleanup fn.
 * `report` defaults to console.warn and exists so tests can capture the leak
 * report without stubbing the console.
 */
export function installGestureLockWatchdog(report?: Reporter): () => void {
  if (installed) return () => {}
  installed = true

  const emit: Reporter =
    report ??
    ((message, owners) => {
      // eslint-disable-next-line no-console
      console.warn(message, { owners })
    })

  let timer: ReturnType<typeof setTimeout> | null = null
  let pointerDown = false

  const clear = () => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  /** The lock is "live" if anything holds a reference OR the class sits on
   *  <body> without one. The second case means something wrote the class
   *  directly instead of going through the refcount — the class is then
   *  unreachable by any release and needs the same recovery. */
  const lockIsLive = () =>
    bodyClassRefCount(LOCK) > 0 || document.body.classList.contains(LOCK)

  const check = () => {
    timer = null
    if (pointerDown) return
    if (!lockIsLive()) return
    if (bodyClassRefCount(LOCK) > 0 && oldestBodyClassRefAge(LOCK) < IDLE_GRACE_MS) {
      timer = setTimeout(check, RECHECK_MS)
      return
    }
    const owners = bodyClassRefCount(LOCK) > 0 ? bodyClassOwners(LOCK) : ['<raw classList write>']
    forceResetBodyClass(LOCK)
    emit(
      `[gestureLockWatchdog] released a stranded "${LOCK}" hold — a gesture owner leaked its reference. Canvas input was wedged until now.`,
      owners,
    )
  }

  const schedule = () => {
    clear()
    if (!lockIsLive()) return
    timer = setTimeout(check, IDLE_GRACE_MS)
  }

  const onDown = (ev: MouseEvent) => {
    pointerDown = true
    void ev
    clear()
  }
  const onUp = (ev: MouseEvent) => {
    pointerDown = buttonsDown(ev)
    if (!pointerDown) schedule()
  }
  const onMove = (ev: MouseEvent) => {
    // Authoritative button state: a mouseup delivered to a native menu (or lost
    // to a window transition) can leave `pointerDown` stale, and every mousemove
    // carries the real bitmask.
    pointerDown = buttonsDown(ev)
    if (!pointerDown && timer === null) schedule()
  }
  const onBlur = () => {
    pointerDown = false
    schedule()
  }

  window.addEventListener('mousedown', onDown, true)
  window.addEventListener('mouseup', onUp, true)
  window.addEventListener('mousemove', onMove, true)
  window.addEventListener('blur', onBlur)

  return () => {
    installed = false
    clear()
    window.removeEventListener('mousedown', onDown, true)
    window.removeEventListener('mouseup', onUp, true)
    window.removeEventListener('mousemove', onMove, true)
    window.removeEventListener('blur', onBlur)
  }
}
