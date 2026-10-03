import { KeyedLock } from '@kernel/state/contract'
import { MAX_CONCURRENT_CODING_AGENTS } from '../../contract'

type CodingAgentAdmissionResult<T> =
  | { admitted: true; result: T }
  | { admitted: false }

/**
 * Worker admission: at most `MAX_CONCURRENT_CODING_AGENTS` active workers per
 * mission. A per-mission lock makes the count plus create atomic; the create
 * records its run before the lock is released, so the next check sees it.
 */
export class CodingAgentAdmission {
  private readonly locks = new KeyedLock()

  constructor(private readonly limit = MAX_CONCURRENT_CODING_AGENTS) {}

  admit<T>(options: {
    ownerPanelId: string
    /** Active (starting, working or waiting) workers of the mission now. */
    active: () => Promise<number> | number
    create: () => Promise<T>
  }): Promise<CodingAgentAdmissionResult<T>> {
    return this.locks.run(options.ownerPanelId, async () => {
      if (await options.active() >= this.limit) return { admitted: false }
      return { admitted: true, result: await options.create() }
    })
  }
}
