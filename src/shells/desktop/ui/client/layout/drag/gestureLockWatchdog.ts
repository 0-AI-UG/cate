// The recovery net for a stranded `canvas-interacting` hold. Every owner of
// the gesture lock is a bounded gesture: a mouse button is held (pan drag,
// marquee, node drag, edge or dock resize) or a wheel-pan quiet timer runs
// (released ~150ms after the wheel stops). Outside those the lock must not be
// held; if it is, an owner's release was orphaned and canvas input is wedged
// (webviews, Monaco and xterm stop hit-testing, `useDragOp` refuses drags)
// until a restart. So whenever the pointer goes idle the watchdog re-checks,
// and a hold that survives IDLE_GRACE_MS with no button down is released and
// reported with its owners. It fires only on a real bug.

import { createLogger } from '@kernel/log/contract'
import { bodyClassOwners, bodyClassRefCount, forceResetBodyClass, oldestBodyClassRefAge } from './dom'

const LOCK = 'canvas-interacting'

/** How long the lock may stay held with no button down before it counts as
 *  stranded: longer than the wheel-pan quiet timer, short enough that a
 *  wedged app recovers within a second of the person noticing. */
export const IDLE_GRACE_MS = 1000

/** Re-check cadence while the pointer is idle and the lock is still held. */
const RECHECK_MS = 500

type Reporter = (message: string, owners: string[]) => void

const log = createLogger('gesture-lock')
let installed = false

/** Installs the watchdog on `window`. Idempotent; returns the uninstall.
 *  `report` defaults to a warning in the log. */
export function installGestureLockWatchdog(report?: Reporter): () => void {
  if (installed) return () => {}
  installed = true
  const emit: Reporter = report ?? ((message, owners) => log.warn('%s owners=%s', message, owners.join(',')))

  let timer: ReturnType<typeof setTimeout> | null = null
  let pointerDown = false

  const clear = () => {
    if (timer !== null) clearTimeout(timer)
    timer = null
  }

  // Live when a reference is held, or when the class sits on <body> without
  // one (written raw, so no release can ever reach it).
  const lockIsLive = () => bodyClassRefCount(LOCK) > 0 || document.body.classList.contains(LOCK)

  const check = () => {
    timer = null
    if (pointerDown || !lockIsLive()) return
    if (bodyClassRefCount(LOCK) > 0 && oldestBodyClassRefAge(LOCK) < IDLE_GRACE_MS) {
      timer = setTimeout(check, RECHECK_MS)
      return
    }
    const owners = bodyClassRefCount(LOCK) > 0 ? bodyClassOwners(LOCK) : ['<raw classList write>']
    forceResetBodyClass(LOCK)
    emit(`Released a stranded "${LOCK}" hold: a gesture owner leaked its reference.`, owners)
  }

  const schedule = () => {
    clear()
    if (lockIsLive()) timer = setTimeout(check, IDLE_GRACE_MS)
  }

  const onDown = () => {
    pointerDown = true
    clear()
  }
  const onUp = (ev: MouseEvent) => {
    pointerDown = ev.buttons !== 0
    if (!pointerDown) schedule()
  }
  // Every move carries the real button mask: a mouseup lost to a native menu
  // or a window change cannot leave `pointerDown` stale.
  const onMove = (ev: MouseEvent) => {
    pointerDown = ev.buttons !== 0
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
