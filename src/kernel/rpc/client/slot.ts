// The runtime slot (architecture 3, 6): kernel code and everything above asks
// for "the runtime of this workspace" here; client/connections fills it.

import type { RuntimeProxy } from '../contract'

export type RuntimeResolver = (workspaceId: string) => RuntimeProxy | null

let resolver: RuntimeResolver | null = null
let version = 0
const listeners = new Set<() => void>()

/** Installs the resolver. Returns a function that removes it again. */
export function setRuntimeResolver(next: RuntimeResolver | null): () => void {
  resolver = next
  notifyRuntimesChanged()
  return () => {
    if (resolver !== next) return
    resolver = null
    notifyRuntimesChanged()
  }
}

/** The typed proxy of an open workspace's runtime. Calls queue until it is
 *  connected. Throws when the workspace is not open. */
export function runtimeFor(workspaceId: string): RuntimeProxy {
  const runtime = tryRuntimeFor(workspaceId)
  if (!runtime) throw new Error(`No runtime for workspace ${workspaceId}`)
  return runtime
}

export function tryRuntimeFor(workspaceId: string): RuntimeProxy | null {
  return resolver ? resolver(workspaceId) : null
}

/** Called by the resolver's owner when a workspace's runtime appears or goes. */
export function notifyRuntimesChanged(): void {
  version++
  for (const listener of [...listeners]) listener()
}

export function subscribeRuntimes(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Increases on every change; a snapshot for useSyncExternalStore. */
export function runtimesVersion(): number {
  return version
}
