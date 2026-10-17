// What the place of a shown workspace draws on its way to showing: the
// desktop side of opening a workspace (`client/workspaces` opening.ts). Its
// windows show only once it is `ready` and the views of its panels are
// loaded; until then the place shows one opening surface, the logo the boot
// splash showed, with one card under it in a fixed spot: the trust question
// (at once), the runtime update (at once), or the connection's status (after
// a grace, then kept up long enough to read). Once ready, ConnectionBlocker
// covers the windows whenever the connection drops.

import { useCallback, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { documentStoreFor } from '@client/document'
import { subscribeWorkspacePhase, trustStore, workspacePhaseOf, type WorkspacePhase } from '@client/workspaces'
import type { ConnectionState, WorkspaceConnection } from '@client/connections'
import { useConnectionState } from '../../../client/connections'
import { panelViewsLoaded, preloadPanelViews } from '../../../client/host/views'
import { tryClientApp } from '../../app'
import { closeWorkspace, selectWorkspace } from '../../navigation'
import { useUIStore } from '../../state/uiStore'
import { ConnectionBlocker, ConnectionStatusCard, StatusCard, useWorkspaceConnection } from '../ConnectionBlocker'
import { RuntimeMismatchCard, useRuntimeUpdate } from '../RuntimeMismatch'
import { useTrustInPlace, WorkspaceTrustCard } from './TrustQuestion'
import { CateLogo } from '../../../kernel/interaction'

/** A card for a wait shorter than this never shows. */
const GRACE_MS = 400
/** A card once shown stays up at least this long. */
const MIN_CARD_MS = 300
const noop = () => () => {}

function useWorkspacePhase(workspaceId: string | null): WorkspacePhase {
  const connections = tryClientApp()?.connections
  const subscribe = useCallback(
    (listener: () => void) => (connections && workspaceId ? subscribeWorkspacePhase(connections, workspaceId, listener) : noop()),
    [connections, workspaceId],
  )
  return useSyncExternalStore(
    subscribe,
    () => (connections && workspaceId ? workspacePhaseOf(connections, workspaceId) : 'closed'),
  )
}

const panelTypesOf = (workspaceId: string) => Object.values(documentStoreFor(workspaceId)?.getSnapshot().panels ?? {}).map((record) => record.type)

/** Whether the views of the workspace's panels are loaded, so it shows with
 *  its panels drawn rather than each loading in turn. Loads them once the
 *  workspace is ready. */
function usePanelViewsLoaded(workspaceId: string | null, ready: boolean): boolean {
  const [loaded, setLoaded] = useState(() => !!workspaceId && ready && panelViewsLoaded(panelTypesOf(workspaceId)))
  useEffect(() => {
    if (!workspaceId || !ready || loaded) return
    let alive = true
    void preloadPanelViews(panelTypesOf(workspaceId)).then(() => { if (alive) setLoaded(true) })
    return () => { alive = false }
  }, [workspaceId, ready, loaded])
  return loaded
}

/** Whether the card shows: after `GRACE_MS` while opening (at once when
 *  `immediate`), and once shown for at least `MIN_CARD_MS`. */
function useOpeningCard(opening: boolean, immediate: boolean): boolean {
  const [shownAt, setShownAt] = useState<number | null>(null)
  useEffect(() => {
    if (opening) {
      if (shownAt !== null) return
      if (immediate) { setShownAt(Date.now()); return }
      const timer = setTimeout(() => setShownAt(Date.now()), GRACE_MS)
      return () => clearTimeout(timer)
    }
    if (shownAt === null) return
    const left = shownAt + MIN_CARD_MS - Date.now()
    if (left <= 0) { setShownAt(null); return }
    const timer = setTimeout(() => setShownAt(null), left)
    return () => clearTimeout(timer)
  }, [opening, immediate, shownAt])
  return shownAt !== null || (opening && immediate)
}

/** The workspace's windows (`children`) once it is ready, its opening
 *  surface until then. */
export function WorkspaceGate({ workspaceId, children }: { workspaceId: string | null; children: ReactNode }): JSX.Element {
  const phase = useWorkspacePhase(workspaceId)
  const viewsLoaded = usePanelViewsLoaded(workspaceId, phase === 'ready')
  const connection = useWorkspaceConnection(workspaceId)
  const state = useConnectionState(connection)
  const updating = useRuntimeUpdate(connection) !== null
  const asking = useSyncExternalStore(trustStore.subscribe, () => !!workspaceId && trustStore.current()?.workspaceId === workspaceId)
  const opening = phase !== 'ready' || !viewsLoaded
  const immediate = asking || updating || state.kind === 'incompatible' || state.kind === 'refused' || state.kind === 'stopped'
  const card = useOpeningCard(opening, immediate)
  // An overlay hides this place (or covers it in a detached window): the
  // question is the modal then.
  const overlay = useUIStore((s) => s.overlay)
  useTrustInPlace(workspaceId, opening && !overlay)

  if (!opening && !card) return <ConnectionBlocker workspaceId={workspaceId}>{children}</ConnectionBlocker>
  return (
    <div className="h-full overflow-y-auto" data-workspace-opening>
      {/* The logo and the card are centered together. */}
      <div className="flex min-h-full flex-col items-center justify-center gap-5 px-4 py-6">
        <CateLogo size={61} className="shrink-0 text-muted opacity-60" aria-hidden="true" />
        {card && workspaceId && (asking
          ? <WorkspaceTrustCard workspaceId={workspaceId} />
          : (
            <div data-connection-blocker className="flex w-full justify-center">
              {(state.kind === 'incompatible' || updating) && connection
                ? <RuntimeMismatchCard connection={connection} />
                : <OpeningStatus workspaceId={workspaceId} connection={connection} state={state} />}
            </div>
          ))}
      </div>
    </div>
  )
}

/** The card while the workspace is not ready: the connection's status, that
 *  it is loading once connected, or that it is not open here. */
function OpeningStatus({ workspaceId, connection, state }: { workspaceId: string; connection: WorkspaceConnection | undefined; state: ConnectionState }): JSX.Element {
  if (!connection || state.kind === 'closed') {
    return (
      <StatusCard
        title="Not open"
        message="This workspace is not open in this window."
        actions={[
          { label: 'Open', run: () => void selectWorkspace(workspaceId) },
          { label: 'Close Workspace', run: () => void closeWorkspace(workspaceId) },
        ]}
      />
    )
  }
  if (state.kind === 'connected') return <StatusCard title="Opening" message="Loading the workspace." busy />
  return <ConnectionStatusCard workspaceId={workspaceId} connection={connection} state={state} />
}
