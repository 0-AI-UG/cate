// =============================================================================
// cateAgentRunWaiters — await a headless Cate Agent session's run completion, and
// track a driver session's outstanding background work.
//
// pi emits `agent_end` once per run (one prompt → completion). The bridge calls
// signalRunEnd() on every agent_end / error; callers that launched a session and
// need to know when its turn is DONE await runEnd(). A timeout backstops a session
// that never ends.
//
// On top of that, a per-iteration DRIVER (codingAgentLauncher) is "settled" only
// when one of its runs ends with NO outstanding background `send_keys` — each
// `send_keys(background:true)` increments a per-driver counter, and the one-shot
// wake that fires when the targeted terminal's coding agent finishes decrements it.
// `runDriverToCompletion` loops `awaitRunEnd` until the counter reaches zero.
// =============================================================================

const waiters = new Map<string, Set<() => void>>()

/** Resolve once the next `agent_end`/error fires for `panelId`, or after `timeoutMs`. */
export function awaitRunEnd(panelId: string, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      const set = waiters.get(panelId)
      if (set) {
        set.delete(finish)
        if (set.size === 0) waiters.delete(panelId)
      }
      resolve()
    }
    const set = waiters.get(panelId) ?? new Set<() => void>()
    set.add(finish)
    waiters.set(panelId, set)
    const timer = setTimeout(finish, timeoutMs)
  })
}

/** Wake every awaitRunEnd() pending on `panelId`. Called by the bridge on a run's
 *  agent_end / error. Harmless for panels nobody is waiting on. */
export function signalRunEnd(panelId: string): void {
  const set = waiters.get(panelId)
  if (!set) return
  // Copy first — finish() mutates the set as it resolves.
  for (const finish of [...set]) finish()
}

// --- driver outstanding background sends ------------------------------------

/** Outstanding background `send_keys` per driver session. A send is outstanding
 *  from the moment it is issued until the targeted terminal's coding agent finishes
 *  (which fires the wake that decrements it). */
const outstanding = new Map<string, number>()

export function incDriverOutstanding(panelId: string): void {
  outstanding.set(panelId, (outstanding.get(panelId) ?? 0) + 1)
}

export function decDriverOutstanding(panelId: string): void {
  const n = (outstanding.get(panelId) ?? 0) - 1
  if (n <= 0) outstanding.delete(panelId)
  else outstanding.set(panelId, n)
}

export function driverOutstanding(panelId: string): number {
  return outstanding.get(panelId) ?? 0
}

export function clearDriverOutstanding(panelId: string): void {
  outstanding.delete(panelId)
}
