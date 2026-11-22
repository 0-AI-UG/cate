// A workspace whose runtime is not connected, for whatever reason, cannot be
// used: its content is inert until the connection is back. Reconnection keeps
// the canvas visible with a compact notice; decisions use a blocking card. The
// cover says what is wrong and offers the action that fixes it. It covers
// this workspace only: the sidebar and other workspaces stay usable. An
// incompatible runtime is resolved right here (RuntimeMismatchCard), which
// stays up through the restart of an update. Every other state shows the
// core's status (`connectionStatus`) and its actions, and while the
// connection waits for a runtime install (this device's, or the machine's),
// how far it is.
//
// A dip that recovers quickly (a reconnect) is not worth a flash, so
// connecting and offline cover only after a short grace; incompatible,
// refused and stopped cover at once.
//
// It covers a workspace that was shown already; until then WorkspaceGate
// (opening/) shows the workspace's opening surface, with the same cards.

import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { AlertCircle, ChevronRight, Copy } from 'lucide-react'
import { clientUi } from '@kernel/interaction'
import { BACKDROP, Spinner } from '../../kernel/interaction'
import { connectionUsable, type ConnectionState, type WorkspaceConnection } from '@client/connections'
import { machineLabel } from '@runtime/daemon/contract'
import { useConnectionState } from '../../client/connections'
import { tryClientApp } from '../app'
import { connectionActions, statusOf, type ConnectionAction } from '../sidebar/connectionStatus'
import { RuntimeMismatchCard, useRequiredRuntimeUpdate, useRuntimeUpdate } from './RuntimeMismatch'
import { InstallProgressView, installTargetOf, useInstallProgress } from './installProgress'

const GRACE_MS = 400
const noop = () => () => {}

export function useWorkspaceConnection(workspaceId: string | null): WorkspaceConnection | undefined {
  const connections = tryClientApp()?.connections
  return useSyncExternalStore(
    connections?.subscribe ?? noop,
    () => (workspaceId ? connections?.get(workspaceId) : undefined),
  )
}

/** Whether the state blocks the workspace (closed: it is being closed). */
const blocks = (state: ConnectionState) => state.kind !== 'connected' && state.kind !== 'closed'

/** The connection of `workspaceId` and whether it blocks the workspace now. */
export function useWorkspaceBlock(workspaceId: string | null): { blocked: boolean; connection: WorkspaceConnection | undefined; state: ConnectionState; updating: boolean } {
  const connection = useWorkspaceConnection(workspaceId)
  const state = useConnectionState(connection)
  const updating = useRuntimeUpdate(connection) !== null
  const mismatch = useRequiredRuntimeUpdate(connection)
  const immediate = !!mismatch || updating || state.kind === 'incompatible' || state.kind === 'refused' || state.kind === 'stopped'
  const [graced, setGraced] = useState(false)
  useEffect(() => {
    if (!blocks(state) || immediate) { setGraced(false); return }
    const timer = setTimeout(() => setGraced(true), GRACE_MS)
    return () => clearTimeout(timer)
  }, [state, immediate])
  return { blocked: !!connection && state.kind !== 'closed' && !connectionUsable(state, mismatch, updating) && (immediate || graced), connection, state, updating }
}

/** Covers `children` (the workspace's windows) while its connection blocks. */
export function ConnectionBlocker({ workspaceId, children }: { workspaceId: string | null; children: ReactNode }): JSX.Element {
  const { blocked, connection, state, updating } = useWorkspaceBlock(workspaceId)
  const mismatch = useRequiredRuntimeUpdate(connection)
  const content = useRef<HTMLDivElement>(null)
  const unavailable = !!connection && (blocks(state) || blocked)
  const quiet = !updating && !mismatch && (state.kind === 'connecting' || state.kind === 'offline')

  // `inert` keeps focus, typing and shortcuts out of the covered panels.
  useEffect(() => {
    const el = content.current
    if (!el) return
    if (unavailable) el.setAttribute('inert', '')
    else el.removeAttribute('inert')
  }, [unavailable])

  return (
    <div className="relative h-full">
      <div ref={content} className="h-full">{children}</div>
      {blocked && (
        <div className={`absolute inset-0 z-[1000] flex items-center justify-center ${quiet ? 'bg-transparent pointer-events-auto p-3' : BACKDROP}`} data-connection-blocker>
          {(mismatch || updating) && connection
            ? <RuntimeMismatchCard connection={connection} />
            : <ConnectionStatusCard workspaceId={workspaceId} connection={connection} state={state} compact={quiet} />}
        </div>
      )}
    </div>
  )
}

/** The connection's status and remedies (`connectionStatus`), with how far
 *  a runtime install it waits for is. */
export function ConnectionStatusCard({ workspaceId, connection, state, compact = false }: { compact?: boolean; workspaceId: string | null; connection: WorkspaceConnection | undefined; state: ConnectionState }): JSX.Element {
  const status = statusOf(connection, state)
  const actions = connectionActions(connection, state)
  const entry = workspaceId ? tryClientApp()?.workspaces.get(workspaceId) : undefined
  const install = useInstallProgress(state.kind === 'connecting' ? installTargetOf(entry) : null)
  return (
    <StatusCard
      title={install ? 'Preparing workspace' : state.kind === 'connecting' ? compact ? 'Reconnecting…' : 'Opening workspace' : status?.title}
      message={install ? 'Setting up what this workspace needs to open.' : compact ? (state.kind === 'offline' && !state.retrying ? 'Your workspace is unavailable. Try connecting again.' : 'Your workspace is temporarily unavailable. Cate will reconnect automatically.') : status?.message}
      details={status?.details ?? (compact ? status?.message : undefined)}
      busy={state.kind === 'connecting'}
      actions={actions}
      compact={compact}
    >
      {install && <div className="mt-1"><InstallProgressView progress={install} where={entry?.kind === 'machine' ? machineLabel(entry.machine) : undefined} /></div>}
    </StatusCard>
  )
}

export function StatusCard({ title, message, details, busy = false, actions = [], children, compact = false }: {
  title?: string
  message?: string
  details?: string
  busy?: boolean
  actions?: ConnectionAction[]
  children?: ReactNode
  compact?: boolean
}): JSX.Element {
  const [copied, setCopied] = useState(false)
  const [copyFailed, setCopyFailed] = useState(false)
  useEffect(() => { setCopied(false); setCopyFailed(false) }, [details])
  const copyDetails = async () => {
    try { await clientUi().writeClipboard?.(details ?? ''); setCopied(true); setCopyFailed(false) }
    catch { setCopyFailed(true) }
  }
  return (
    <section aria-label={title} aria-busy={busy} className={`w-[400px] max-w-full min-w-0 text-left ${compact ? 'rounded-[10px] border border-white/[0.08] bg-surface-1 p-4 shadow-[0_16px_48px_-16px_rgb(0_0_0/0.8)]' : 'px-2 py-4'}`}>
      <div className="mb-4 flex h-9 w-9 items-center justify-center rounded-lg border border-subtle bg-surface-1 text-secondary" aria-hidden="true">
        {busy ? <Spinner size={17} /> : <AlertCircle size={18} />}
      </div>
      <div className="flex flex-col gap-2.5">
        <div role="status" aria-live="polite">
          <h2 className="text-[18px] font-medium tracking-[-0.02em] text-primary">{title}</h2>
          {message && <p data-status-message className="mt-2 text-[13px] leading-[1.65] text-secondary break-words">{message}</p>}
        </div>
        {children}
        {actions.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {actions.map((action, i) => (
              <button key={action.label} type="button" className={`inline-flex h-8 items-center justify-center rounded-md px-3 text-xs font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-blue ${i === 0 ? 'bg-primary text-inverse hover:opacity-90' : 'text-secondary hover:bg-hover hover:text-primary'}`} onClick={action.run}>
                {action.label}
              </button>
            ))}
          </div>
        )}
        {details && <details className="group mt-3 min-w-0 border-t border-subtle pt-3 text-[11px] text-muted">
          <summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 rounded hover:text-primary focus-visible:outline-focus-blue [&::-webkit-details-marker]:hidden"><ChevronRight size={12} className="transition-transform group-open:rotate-90" />Technical details</summary>
          <div className="mt-3 overflow-hidden rounded-md border border-subtle bg-surface-1">
            <div className="flex min-h-8 items-center justify-between gap-2 border-b border-subtle px-3"><span>Connection diagnostic</span>
              {clientUi().writeClipboard && <button type="button" onClick={() => void copyDetails()} className="inline-flex items-center gap-1.5 py-1 text-secondary hover:text-primary"><Copy size={11} />{copyFailed ? 'Try copying again' : copied ? 'Copied' : 'Copy'}</button>}
            </div>
            <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words p-3 font-mono text-[11px] leading-relaxed text-secondary select-text">{details}</pre>
          </div>
        </details>}
      </div>
    </section>
  )
}
