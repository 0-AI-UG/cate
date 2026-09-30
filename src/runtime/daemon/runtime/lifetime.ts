// How long the runtime runs (architecture 7.4). `stopWhenIdle` stops it after
// a grace period with no client and no work; `keepRunning`, or network access
// on, keeps it running.

import type { RuntimeLifetime, RuntimeNetwork } from '../contract'

export const IDLE_GRACE_MS = 5 * 60_000

export interface LifetimeSettings {
  runtimeLifetime(): RuntimeLifetime
  runtimeNetwork(): RuntimeNetwork
  /** Called on any settings change. */
  subscribe(listener: () => void): () => void
}

export interface LifetimeDeps {
  settings: LifetimeSettings
  busy: () => boolean
  /** Connected clients (not callers such as the CLI or T3). */
  clients: () => number
  /** Client connected or gone; returns the unsubscribe. */
  onClientsChanged: (listener: () => void) => () => void
  /** Stops the runtime. Called at most once. */
  stop: () => void
  graceMs?: number
  /** How often `busy` is re-read. Default 30 s. */
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

  const idle = () =>
    deps.settings.runtimeLifetime() === 'stopWhenIdle'
    && deps.settings.runtimeNetwork() === 'off'
    && deps.clients() === 0
    && !deps.busy()

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

  const offSettings = deps.settings.subscribe(check)
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
