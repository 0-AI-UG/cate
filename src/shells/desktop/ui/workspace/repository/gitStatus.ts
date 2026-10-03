// React side of the git status store: one store per workspace runtime, shared
// by every view that shows a checkout's status (file tree tint, source
// control, worktree menus).

import { useMemo, useSyncExternalStore } from 'react'
import type { RuntimeProxy } from '@kernel/rpc/contract'
import { useRuntime } from '../../kernel/rpc'
import { createGitStatusStore, EMPTY_GIT_STATUS, type GitStatusSnapshot, type GitStatusStore } from '@workspace/repository/client'

const stores = new WeakMap<RuntimeProxy, GitStatusStore>()

/** The shared git status store of a runtime. */
export function gitStatusStoreFor(runtime: RuntimeProxy): GitStatusStore {
  let store = stores.get(runtime)
  if (!store) {
    store = createGitStatusStore(runtime.vcs)
    stores.set(runtime, store)
  }
  return store
}

const noop = () => () => {}
const empty = () => EMPTY_GIT_STATUS

/** A checkout's live status in a workspace; EMPTY_GIT_STATUS until the first
 *  snapshot, while the workspace is not open, or for an empty `cwd`. */
export function useGitStatus(workspaceId: string | null | undefined, cwd: string): GitStatusSnapshot {
  const runtime = useRuntime(workspaceId)
  const store = runtime && cwd ? gitStatusStoreFor(runtime) : null
  const subscribe = useMemo(() => (store ? (l: () => void) => store.subscribe(cwd, l) : noop), [store, cwd])
  const get = useMemo(() => (store ? () => store.getSnapshot(cwd) : empty), [store, cwd])
  return useSyncExternalStore(subscribe, get, empty)
}
