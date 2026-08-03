import { MAX_CONCURRENT_CODING_AGENTS } from '../../shared/codingAgentRuns'
import type { WindowPanelInfo } from '../../shared/types'
import { KeyedLock } from '../keyedLock'

const ACTIVE_STATUSES = new Set(['starting', 'working', 'waiting'])
const REPORT_BRIDGE_TTL_MS = 10_000

interface Reservation {
  runId: string
  createdAt: number
}

export type CodingAgentAdmissionResult<T> =
  | { admitted: true; result: T }
  | { admitted: false }

/** Main-process authority for mission worker admission.
 *
 * Renderer reports provide the cross-window active set. A per-mission lock
 * makes the check plus create atomic, while short-lived reservations bridge
 * the renderer's debounced report after a successful create. The renderer's
 * local check remains a defensive validation, not the concurrency authority.
 */
export class CodingAgentAdmissionController {
  private readonly locks = new KeyedLock()
  private readonly reservations = new Map<string, Reservation[]>()

  constructor(private readonly now: () => number = Date.now) {}

  admit<T>(options: {
    workspaceId: string
    ownerPanelId: string
    panels: () => WindowPanelInfo[]
    create: () => Promise<T>
  }): Promise<CodingAgentAdmissionResult<T>> {
    const key = this.missionKey(options.workspaceId, options.ownerPanelId)
    return this.locks.run(key, async () => {
      const panels = options.panels()
      const reportedRunIds = new Set(
        panels
          .filter((panel) =>
            panel.workspaceId === options.workspaceId
            && panel.codingAgentOwnerPanelId === options.ownerPanelId
            && typeof panel.codingAgentRunId === 'string',
          )
          .map((panel) => panel.codingAgentRunId!),
      )
      const activeRunIds = new Set(
        panels
          .filter((panel) =>
            panel.workspaceId === options.workspaceId
            && panel.codingAgentOwnerPanelId === options.ownerPanelId
            && typeof panel.codingAgentRunId === 'string'
            && ACTIVE_STATUSES.has(panel.codingAgentStatus ?? ''),
          )
          .map((panel) => panel.codingAgentRunId!),
      )
      const cutoff = this.now() - REPORT_BRIDGE_TTL_MS
      const pending = (this.reservations.get(key) ?? []).filter((reservation) =>
        reservation.createdAt >= cutoff && !reportedRunIds.has(reservation.runId),
      )
      if (pending.length > 0) this.reservations.set(key, pending)
      else this.reservations.delete(key)

      if (activeRunIds.size + pending.length >= MAX_CONCURRENT_CODING_AGENTS) {
        return { admitted: false }
      }

      const result = await options.create()
      if (this.successfulRunId(result)) {
        const reservations = this.reservations.get(key) ?? []
        reservations.push({ runId: result.id, createdAt: this.now() })
        this.reservations.set(key, reservations)
      }
      return { admitted: true, result }
    })
  }

  clearMission(workspaceId: string, ownerPanelId: string): void {
    this.reservations.delete(this.missionKey(workspaceId, ownerPanelId))
  }

  clearWorkspace(workspaceId: string): void {
    const prefix = `${JSON.stringify(workspaceId)}:`
    for (const key of this.reservations.keys()) {
      if (key.startsWith(prefix)) this.reservations.delete(key)
    }
  }

  clearAll(): void {
    this.reservations.clear()
  }

  private missionKey(workspaceId: string, ownerPanelId: string): string {
    return `${JSON.stringify(workspaceId)}:${JSON.stringify(ownerPanelId)}`
  }

  private successfulRunId(result: unknown): result is { id: string } {
    return Boolean(
      result
      && typeof result === 'object'
      && !('error' in result)
      && typeof (result as { id?: unknown }).id === 'string',
    )
  }
}

export const codingAgentAdmission = new CodingAgentAdmissionController()
