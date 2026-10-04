// Panel views in the app (`panel.*` in the core API). Each follows its
// panel's session on the workspace's connection, across reconnects, and
// pushes the snapshot whole to the app as `snapshot` events; the app sends
// the panel type's ops back. Browser and chat views add what their pages
// need on top (browser.ts, chat.ts).

import type { SessionHandle, WorkspaceConnection } from '@client/connections'
import { errorMessage } from '@kernel/interaction'
import { isRpcError } from '@kernel/rpc/contract'
import type { MobileBridge, MobileOpResult, MobileViewEvent } from '../contract'
import type { MobileClient } from './boot'

export interface PanelViewParams {
  viewId: string
  workspaceId: string
  panelId: string
}

export interface PanelView<S = unknown> {
  readonly workspaceId: string
  readonly panelId: string
  /** The session's snapshot; null before the first one. */
  snapshot(): S | null
  /** Called after every snapshot change, before the app is told. */
  onSnapshot(listener: (snapshot: S) => void): void
  emit(event: MobileViewEvent): void
  send(op: unknown): Promise<unknown>
  /** Called once when the view closes. */
  onClose(listener: () => void): void
  close(): void
}

export interface MobileViews {
  open<S>(params: PanelViewParams): PanelView<S>
  get<S>(viewId: string): PanelView<S> | undefined
  op(viewId: string, op: unknown): Promise<MobileOpResult>
}

export function opResult(promise: Promise<unknown>): Promise<MobileOpResult> {
  return promise.then(
    (result) => ({ ok: true as const, result: result ?? null }),
    (error: unknown) => ({ ok: false as const, message: errorMessage(error), code: isRpcError(error) ? error.code : null }),
  )
}

export function createMobileViews(client: MobileClient, bridge: MobileBridge): MobileViews {
  const views = new Map<string, PanelView>()

  function openView<S>({ viewId, workspaceId, panelId }: PanelViewParams): PanelView<S> {
    let connection: WorkspaceConnection | null = null
    let session: SessionHandle<S> | null = null
    let offSession: (() => void) | null = null
    let closed = false
    const listeners: Array<(snapshot: S) => void> = []
    const closers: Array<() => void> = []

    const emit = (event: MobileViewEvent) => {
      if (!closed) void bridge('view.event', { viewId, json: JSON.stringify(event) }).catch(() => {})
    }
    const update = () => {
      const snapshot = session?.getSnapshot()?.snapshot
      if (snapshot === undefined || snapshot === null) return
      for (const listener of listeners) listener(snapshot)
      emit({ kind: 'snapshot', snapshot })
    }
    const unsubscribe = () => {
      offSession?.()
      session?.release()
      offSession = null
      session = null
    }
    const follow = () => {
      const next = client.connections.get(workspaceId) ?? null
      if (next === connection) return
      unsubscribe()
      connection = next
      if (!connection) return
      session = connection.subscribeSession<S>(panelId)
      offSession = session.subscribe(update)
      update()
    }
    const offConnections = client.connections.subscribe(follow)

    const view: PanelView<S> = {
      workspaceId,
      panelId,
      snapshot: () => session?.getSnapshot()?.snapshot ?? null,
      onSnapshot: (listener) => { listeners.push(listener) },
      emit,
      send(op) {
        if (!session) return Promise.reject(new Error('The workspace is not connected.'))
        return session.send(op)
      },
      onClose: (listener) => { closers.push(listener) },
      close() {
        if (closed) return
        closed = true
        offConnections()
        unsubscribe()
        for (const closer of closers) closer()
        if (views.get(viewId) === view) views.delete(viewId)
      },
    }
    views.get(viewId)?.close()
    views.set(viewId, view as PanelView)
    // Extensions attach their listeners before the first snapshot.
    queueMicrotask(() => { if (!closed) follow() })
    return view
  }

  return {
    open: openView,
    get: <S>(viewId: string) => views.get(viewId) as PanelView<S> | undefined,
    op(viewId, op) {
      const view = views.get(viewId)
      if (!view) return Promise.resolve({ ok: false, message: 'The panel is not open.', code: null })
      return opResult(view.send(op))
    },
  }
}
