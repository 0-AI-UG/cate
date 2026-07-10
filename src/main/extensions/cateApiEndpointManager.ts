import { randomBytes } from 'crypto'
import log from '../logger'
import { KeyedLock } from '../keyedLock'
import { parseLocator } from '../runtime/locator'
import { runtimes } from '../runtime/runtimeManager'
import type { Runtime } from '../runtime/types'
import { getWorkspaceInfo } from '../workspaceManager'
import type { ReverseTunnelBinding } from './cateApiReverse'

type CateApiEndpointOwner = 'extension' | 'first-party'

interface CateApiEndpoint {
  runtime: Runtime
  cwd: string
  port: number
  token: string
}

interface EndpointSession extends CateApiEndpoint {
  key: string
  owner: CateApiEndpointOwner
  binding: ReverseTunnelBinding
}

interface CateApiEndpointOptions {
  key: string
  owner: CateApiEndpointOwner
  extensionId: string
  workspaceId: string
  listenerId: string
  caller?: 'first-party'
  grantedScopes?: string[]
}

export function resolveWorkspaceRuntime(workspaceId: string): { runtime: Runtime; cwd: string } {
  const info = getWorkspaceInfo(workspaceId)
  const { runtimeId, path: cwd } = parseLocator(info?.rootPath ?? '')
  return { runtime: runtimes.resolve(runtimeId), cwd }
}

/** Owns every reverse CATE_API endpoint, regardless of whether the caller is an
 * extension server, terminal, or agent. Token minting, runtime resolution,
 * listener binding, caching, serialization, and teardown all live here. */
export class CateApiEndpointManager {
  private readonly sessions = new Map<string, EndpointSession>()
  private readonly locks = new KeyedLock()

  ensure(options: CateApiEndpointOptions): Promise<CateApiEndpoint> {
    return this.locks.run(options.key, async () => {
      const existing = this.sessions.get(options.key)
      if (existing) return this.publicEndpoint(existing)

      const { runtime, cwd } = resolveWorkspaceRuntime(options.workspaceId)
      const token = randomBytes(32).toString('base64url')
      // cateApiReverse reaches the extension dispatch layer, which imports the
      // global managers. Load it only after construction to keep that graph
      // acyclic.
      const { bindReverseTunnel, createCateApiReverse } = await import('./cateApiReverse')
      const reverse = createCateApiReverse({
        extensionId: options.extensionId,
        workspaceId: options.workspaceId,
        token,
        runtime,
        caller: options.caller,
        grantedScopes: options.grantedScopes,
      })
      try {
        const binding = await bindReverseTunnel(runtime, reverse, options.listenerId)
        const session: EndpointSession = {
          key: options.key,
          owner: options.owner,
          runtime,
          cwd,
          port: binding.port,
          token,
          binding,
        }
        this.sessions.set(options.key, session)
        return this.publicEndpoint(session)
      } catch (err) {
        try { reverse.dispose() } catch { /* already disposed */ }
        try { runtime.tunnel.stopListen(options.listenerId) } catch { /* listener never opened */ }
        throw err
      }
    })
  }

  dispose(key: string): void {
    const session = this.sessions.get(key)
    if (!session) return
    session.binding.dispose()
    this.sessions.delete(key)
  }

  disposeForRuntime(owner: CateApiEndpointOwner, runtimeId: string): void {
    this.disposeWhere((session) => session.owner === owner && session.runtime.id === runtimeId)
  }

  disposeAll(owner: CateApiEndpointOwner): void {
    this.disposeWhere((session) => session.owner === owner)
  }

  private disposeWhere(predicate: (session: EndpointSession) => boolean): void {
    for (const [key, session] of [...this.sessions]) {
      if (!predicate(session)) continue
      try { session.binding.dispose() } catch (err) {
        log.warn('[cate-api] endpoint disposal failed for %s: %O', key, err)
      }
      this.sessions.delete(key)
    }
  }

  private publicEndpoint(session: EndpointSession): CateApiEndpoint {
    return { runtime: session.runtime, cwd: session.cwd, port: session.port, token: session.token }
  }
}

export const cateApiEndpointManager = new CateApiEndpointManager()
