// Whether the workspace stays available (architecture 7.4): while a trigger
// that `keepRunningWhile` picks holds, the runtime keeps running (lifetime)
// and its machine stays awake (power).

import type { KeepRunningTrigger } from '../contract'
import type { BusyRegistry } from './busy'

/** A client counts as in use this long after its last action. */
export const IN_USE_MS = 10 * 60_000

export interface KeepRunningClient {
  /** Its app has the person's attention. */
  attentive: boolean
  lastActiveAt: number
}

export interface KeepRunningDeps {
  triggers: () => readonly KeepRunningTrigger[]
  work: BusyRegistry
  /** Every connected client, as presence knows it. */
  clients: () => readonly KeepRunningClient[]
  now?: () => number
}

/** A client is in use while it has the person's attention and acted lately. */
export function clientInUse(client: KeepRunningClient, now: number): boolean {
  return client.attentive && now - client.lastActiveAt < IN_USE_MS
}

/** True while a picked trigger holds. */
export function createKeepRunning(deps: KeepRunningDeps): () => boolean {
  const now = deps.now ?? Date.now
  return () => {
    const triggers = deps.triggers()
    if (triggers.includes('always')) return true
    const work = triggers.filter((t): t is 'agents' | 'commands' => t === 'agents' || t === 'commands')
    if (work.length > 0 && deps.work.busy(work)) return true
    if (triggers.includes('clients')) {
      const at = now()
      if (deps.clients().some((client) => clientInUse(client, at))) return true
    }
    return false
  }
}
