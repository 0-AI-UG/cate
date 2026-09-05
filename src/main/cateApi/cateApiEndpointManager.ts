import { randomBytes } from 'crypto'
import log from '../logger'
import { KeyedLock } from '../keyedLock'
import { parseLocator } from '../../shared/runtimeLocator'
import { runtimes } from '../runtime/runtimeManager'
import type { Runtime } from '../runtime/types'
import { getWorkspaceInfo } from '../workspaceManager'
import type { ReverseTunnelBinding } from './cateApiReverse'

interface CateApiEndpoint {
  runtime: Runtime
  cwd: string
  port: number
  token: string
}

interface EndpointSession extends CateApiEndpoint {
  key: string
  binding: ReverseTunnelBinding
}

interface CateApiEndpointOptions {
  key: string
  workspaceId: string
  listenerId: string
}

export function resolveWorkspaceRuntime(workspaceId: string): { runtime: Runtime; cwd: string } {
  const info = getWorkspaceInfo(workspaceId)
  const { runtimeId, path: cwd } = parseLocator(info?.rootPath ?? '')
  return { runtime: runtimes.resolve(runtimeId), cwd }
}

export class CateApiEndpointManager {
  private readonly sessions = new Map<string, EndpointSession>()
  private readonly locks = new KeyedLock()
  private lifecycleGeneration = 0
  private readonly disposedKeys = new Map<string, number>()
  private disposedAllAt = 0
  private readonly disposedRuntimes = new Map<string, number>()

  ensure(options: CateApiEndpointOptions): Promise<CateApiEndpoint> {
    // Capture before entering the async lock. A synchronous teardown that lands
    // before this callback starts must still cancel this particular ensure; a
    // later ensure captures the newer generation and may create a fresh endpoint.
    const startedAt = this.lifecycleGeneration
    return this.locks.run(options.key, async () => {
      const existing = this.sessions.get(options.key)
      if (existing) return this.publicEndpoint(existing)

      const { runtime, cwd } = resolveWorkspaceRuntime(options.workspaceId)
      if (this.wasDisposedSince(options, runtime.id, startedAt)) {
        throw new Error(`CATE_API endpoint disposed while opening: ${options.key}`)
      }
      const token = randomBytes(32).toString('base64url')
      const { bindReverseTunnel, createCateApiReverse } = await import('./cateApiReverse')
      const reverse = createCateApiReverse({
        workspaceId: options.workspaceId,
        token,
        runtime,
      })
      let binding: ReverseTunnelBinding
      try {
        binding = await bindReverseTunnel(runtime, reverse, options.listenerId)
      } catch (err) {
        try { reverse.dispose() } catch { /* already disposed */ }
        try { runtime.tunnel.stopListen(options.listenerId) } catch { /* listener never opened */ }
        throw err
      }
      // dispose/disposeForRuntime/disposeAll are synchronous by design. If one
      // ran while the listener was opening, tear down the completed binding
      // instead of publishing a session that the teardown never saw.
      if (this.wasDisposedSince(options, runtime.id, startedAt)) {
        try { binding.dispose() } catch (err) {
          log.warn('[cate-api] endpoint disposal failed for %s: %O', options.key, err)
        }
        throw new Error(`CATE_API endpoint disposed while opening: ${options.key}`)
      }
      const session: EndpointSession = {
        key: options.key,
        runtime,
        cwd,
        port: binding.port,
        token,
        binding,
      }
      this.sessions.set(options.key, session)
      return this.publicEndpoint(session)
    })
  }

  dispose(key: string): void {
    this.disposedKeys.set(key, ++this.lifecycleGeneration)
    const session = this.sessions.get(key)
    if (!session) return
    this.sessions.delete(key)
    try { session.binding.dispose() } catch (err) {
      log.warn('[cate-api] endpoint disposal failed for %s: %O', key, err)
    }
  }

  disposeForRuntime(runtimeId: string): void {
    this.disposedRuntimes.set(runtimeId, ++this.lifecycleGeneration)
    this.disposeWhere((session) => session.runtime.id === runtimeId)
  }

  disposeAll(): void {
    this.disposedAllAt = ++this.lifecycleGeneration
    this.disposeWhere(() => true)
  }

  private wasDisposedSince(
    options: CateApiEndpointOptions,
    runtimeId: string,
    generation: number,
  ): boolean {
    return (this.disposedKeys.get(options.key) ?? 0) > generation
      || this.disposedAllAt > generation
      || (this.disposedRuntimes.get(runtimeId) ?? 0) > generation
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
