// =============================================================================
// Deferred workspace restore — neutral injection point that breaks the
// appStore <-> session circular import.
//
// appStore needs to (a) check whether a workspace has a pending snapshot and
// (b) trigger its restore on first switch; session owns the real restore logic
// and writes the snapshots. Previously appStore imported both the Map and the
// restore function directly from session, while session imported appStore — a
// cycle. This module owns the snapshot Map and a registration slot for the
// restore function instead, importing NOTHING from appStore or session. session
// registers its real handler at module load; appStore imports only from here.
// =============================================================================

import type { SessionSnapshot } from '../../../shared/types'

// Deferred snapshots for inactive workspaces — restored on first switch.
export const deferredSnapshots = new Map<string, SessionSnapshot>()

let restoreHandler: ((workspaceId: string) => Promise<void>) | null = null

/** Register the real deferred-restore implementation (called by session.ts). */
export function setDeferredRestoreHandler(fn: (workspaceId: string) => Promise<void>): void {
  restoreHandler = fn
}

/**
 * Restore a deferred workspace by delegating to the registered handler. No-ops
 * if no handler has been registered yet (handler is wired up at session module
 * load, which happens during app bootstrap before any workspace switch).
 */
export async function restoreDeferredWorkspace(workspaceId: string): Promise<void> {
  if (!restoreHandler) return
  await restoreHandler(workspaceId)
}
