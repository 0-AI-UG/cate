import { useEffect, useState, useSyncExternalStore } from 'react'
import { subscribeRuntimes, tryRuntimeFor } from '@kernel/rpc/client'
import type { ConnectionState, WorkspaceConnection } from '../connection'

const NONE: ConnectionState = { kind: 'closed' }
const noop = () => () => {}

/** The connection's state; `closed` without a connection. */
export function useConnectionState(connection: WorkspaceConnection | null | undefined): ConnectionState {
  return useSyncExternalStore(connection?.subscribe ?? noop, connection?.getState ?? (() => NONE))
}

/** Canonical roots the runtimes reported, by workspace. */
const canonicalRoots = new Map<string, string>()

/** The workspace's canonical root as its runtime reports it (`workspace.info`),
 *  '' until known. Compare workspace paths against this, never the root a
 *  local entry was opened with (it may run through a symlink). */
export function useWorkspaceRoot(workspaceId: string | null | undefined): string {
  const [root, setRoot] = useState(() => (workspaceId && canonicalRoots.get(workspaceId)) || '')
  useEffect(() => {
    setRoot((workspaceId && canonicalRoots.get(workspaceId)) || '')
    if (!workspaceId) return
    let alive = true
    let asked: unknown = null
    const load = () => {
      const runtime = tryRuntimeFor(workspaceId)
      if (!runtime || runtime === asked) return
      asked = runtime
      runtime.workspace.info().then((info) => {
        canonicalRoots.set(workspaceId, info.root)
        if (alive) setRoot(info.root)
      }, () => { asked = null })
    }
    load()
    const off = subscribeRuntimes(load)
    return () => { alive = false; off() }
  }, [workspaceId])
  return root
}
