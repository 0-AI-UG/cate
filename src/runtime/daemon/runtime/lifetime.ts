// How long the runtime runs (architecture 7.4): it stops after a grace period
// with no client connected and nothing keeping it running.

export const IDLE_GRACE_MS = 5 * 60_000

export interface LifetimeDeps {
  /** A `keepRunningWhile` trigger or a keep-awake request holds. */
  held: () => boolean
  /** Settings changed; returns the unsubscribe. */
  onSettingsChanged: (listener: () => void) => () => void
  /** Connected clients (not callers such as the CLI or T3). */
  clients: () => number
  /** Client connected or gone; returns the unsubscribe. */
  onClientsChanged: (listener: () => void) => () => void
  /** Stops the runtime. Called at most once. */
  stop: () => void
  graceMs?: number
  /** How often `held` is re-read. Default 30 s. */
  pollMs?: number
}

export interface Lifetime {
  /** Re-checks now, e.g. after work ended. */
  check(): void
  /** True while the idle countdown runs. */
  counting(): boolean
  dispose(): void
}

export function createLifetime(deps: LifetimeDeps): Lifetime {
  const graceMs = deps.graceMs ?? IDLE_GRACE_MS
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false

  const idle = () => deps.clients() === 0 && !deps.held()

  const check = () => {
    if (stopped) return
    if (!idle()) {
      if (timer) clearTimeout(timer)
      timer = null
      return
    }
    if (timer) return
    timer = setTimeout(() => {
      timer = null
      if (stopped || !idle()) return
      stopped = true
      deps.stop()
    }, graceMs)
  }

  const offSettings = deps.onSettingsChanged(check)
  const offClients = deps.onClientsChanged(check)
  const poll = setInterval(check, deps.pollMs ?? 30_000)
  poll.unref?.()
  check()

  return {
    check,
    counting: () => timer !== null,
    dispose() {
      stopped = true
      if (timer) clearTimeout(timer)
      timer = null
      clearInterval(poll)
      offSettings()
      offClients()
    },
  }
}
