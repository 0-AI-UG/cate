import type { CompanionPhase, WorkspaceState } from '../../shared/types'

// =============================================================================
// The ONE place that turns a workspace's stored state (connection record +
// canonical companion phase) into the runtime status the whole UI switches on.
// Every consumer — the canvas lock, the sidebar dot, the git-monitor gate —
// reads from here so they can never disagree about whether a workspace is
// editable or which recovery action to offer.
// =============================================================================

/** Mirrors CompanionPhase, plus `local` for workspaces with no companion. */
type WorkspaceRuntimeStatus = 'local' | CompanionPhase

export interface WorkspaceRuntime {
  status: WorkspaceRuntimeStatus
  /** The canvas is interactive ONLY for `local` and `connected`. Everything
   *  else (installing/connecting/disconnected/unreachable/missing) blocks it. */
  editable: boolean
  /** Failure reason for disconnected/unreachable/missing. */
  error?: string
  /** Whether a stored connection record exists to reconnect against. False
   *  during an initial connect that hasn't succeeded yet — the recovery UX then
   *  offers "Edit connection" (re-enter host/path/auth) rather than a bare retry. */
  hasConnection: boolean
}

/**
 * Derive a workspace's canonical runtime status.
 *
 * A workspace is treated as remote when it has a non-local connection record OR
 * an in-flight companion runtime (the optimistic seed set during the very first
 * connect, before the connection record is persisted). Otherwise it is local
 * and always editable.
 */
export function workspaceRuntime(ws: WorkspaceState | undefined): WorkspaceRuntime {
  const conn = ws?.connection
  const companion = ws?.companion
  const isRemote = (!!conn && conn.kind !== 'local') || !!companion
  if (!isRemote) return { status: 'local', editable: true, hasConnection: false }

  const hasConnection = !!conn && conn.kind !== 'local'
  const error = companion?.error
  // No phase yet on a remote workspace (e.g. session restore in progress) reads
  // as still connecting, so the canvas stays blocked until it resolves.
  const phase = companion?.phase ?? 'connecting'

  switch (phase) {
    case 'connected':
      return { status: 'connected', editable: true, hasConnection }
    case 'installing':
      return { status: 'installing', editable: false, hasConnection }
    case 'connecting':
      return { status: 'connecting', editable: false, hasConnection }
    case 'disconnected':
      return { status: 'disconnected', editable: false, error, hasConnection }
    case 'unreachable':
      return { status: 'unreachable', editable: false, error, hasConnection }
    case 'missing':
      return { status: 'missing', editable: false, error, hasConnection }
  }
}
