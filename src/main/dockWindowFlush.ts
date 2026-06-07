// =============================================================================
// dockWindowFlush — pre-quit coordination for detached dock windows.
//
// Quit-time race: saveSession() (in the main renderer) reads listDockWindows(),
// which returns main's CACHED dockWindowState. Dock windows only push that state
// on a 5s interval / focus / beforeunload, so a change made immediately before
// quit can leave the cache stale — the session file then persists old dock
// layout / terminal scrollback / canvas nodes.
//
// Fix: before the main renderer's session flush runs, request a FINAL sync from
// every dock window and AWAIT their ACKs, bounded by a short timeout so quit can
// never hang on an unresponsive window. The Electron wiring lives in index.ts;
// the pure await-all-with-timeout logic lives here so it's unit-testable.
// =============================================================================

/**
 * Request a final sync from each dock window and resolve once ALL have ACKed,
 * or the timeout fires — whichever comes first. Never rejects and never hangs:
 * a slow/dead window is simply skipped after `timeoutMs`.
 *
 * Pure of Electron: callers supply `windowIds`, a `requestSync(id)` that asks one
 * window to sync, a `subscribeAck(handler)` that invokes `handler(id)` whenever a
 * window ACKs (returning an unsubscribe), and a `setTimeoutFn`/`clearTimeoutFn`
 * pair (defaulting to the globals) so tests can drive the clock.
 *
 * Resolves with the set of window ids that ACKed in time.
 */
export function flushDockWindowsBeforeQuit(opts: {
  windowIds: number[]
  requestSync: (windowId: number) => void
  subscribeAck: (handler: (windowId: number) => void) => () => void
  timeoutMs: number
  setTimeoutFn?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimeoutFn?: (handle: ReturnType<typeof setTimeout>) => void
}): Promise<Set<number>> {
  const {
    windowIds,
    requestSync,
    subscribeAck,
    timeoutMs,
    // Wrap the globals (rather than defaulting straight to them) so the binding
    // adopts this interface's exact signature instead of the global overloads'
    // wider `number | NodeJS.Timeout` return, which varies by @types/node version
    // and broke the `timer` assignment below on CI.
    setTimeoutFn = (fn, ms) => setTimeout(fn, ms),
    clearTimeoutFn = (handle) => clearTimeout(handle),
  } = opts

  // Nothing to wait for — resolve immediately so quit isn't delayed.
  if (windowIds.length === 0) return Promise.resolve(new Set<number>())

  return new Promise<Set<number>>((resolve) => {
    const pending = new Set(windowIds)
    const acked = new Set<number>()
    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let unsubscribe: () => void = () => {}

    const finish = (): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeoutFn(timer)
      unsubscribe()
      resolve(acked)
    }

    unsubscribe = subscribeAck((windowId) => {
      if (!pending.has(windowId)) return
      pending.delete(windowId)
      acked.add(windowId)
      if (pending.size === 0) finish()
    })

    timer = setTimeoutFn(finish, timeoutMs)

    // Ask every window to sync AFTER the ack subscription is live, so an
    // unusually fast ACK can't slip through before we're listening.
    for (const id of windowIds) {
      try {
        requestSync(id)
      } catch {
        // A window that can't be messaged (e.g. already gone) just won't ACK;
        // the timeout covers it.
      }
    }
  })
}
