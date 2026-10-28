// Browser partitions and their loopback web proxies (architecture 12.3). One
// partition per workspace runtime (`persist:ws-<runtimeId>`, shared by its
// browser panels). Connections allowed to reach this machine's network use
// Chromium's native networking; others use the workspace proxy, including
// loopback. The proxy reaches loopback
// ports through a renderer that holds the workspace connection: main asks it
// for a pipe per connection (`dialLoopback` there is the transport's choice).

import type { Session } from 'electron'
import type { ByteDuplex } from '@kernel/rpc/contract'
import { createLogger } from '@kernel/log/contract'
import { isRuntimeId } from '@runtime/data/contract'
import { workspacePartition } from '@services/browser/contract'
import { createProxyCredentials, startLoopbackProxy, type LoopbackProxy, type ProxyCredentials } from './loopbackProxy'
import { authenticatedBrowserProxy, browserProxyConfig } from './browserProxy'

const log = createLogger('web')

export interface LoopbackDialer {
  readonly id: number
  isDestroyed(): boolean
  /** Asks this renderer for a pipe to `port` on the runtime's machine. */
  dial(runtimeId: string, port: number): Promise<ByteDuplex>
}

export interface WebPartitionsDeps {
  session(partition: string): Pick<Session, 'setProxy' | 'closeAllConnections'>
  /** The client's `browserProxyUrl`. */
  upstream(): string | undefined
  /** Seam for tests. */
  startProxy?: typeof startLoopbackProxy
}

export interface WebPartitions {
  readonly credentials: ProxyCredentials
  /** Prepares the workspace's partition and registers `dialer` for its
   *  loopback requests; the partition name. `reachesClientNetwork`: the
   *  dialer's connection is on this machine's network (12.3). */
  partitionFor(runtimeId: string, dialer: LoopbackDialer, reachesClientNetwork: boolean): Promise<string>
  release(runtimeId: string, dialerId: number): void
  /** Drops every registration of a renderer that went away. */
  releaseDialer(dialerId: number): void
  /** True for a workspace partition whose network policy is in place. */
  isPrepared(partition: string): boolean
  /** Reapply changed client proxy settings to every prepared partition. */
  refresh(): Promise<void>
  /** Answers Chromium's proxy auth challenge for our proxies. */
  credentialsFor(host: string, port: number): ProxyCredentials | null
  close(): Promise<void>
}

export function createWebPartitions(deps: WebPartitionsDeps): WebPartitions {
  const credentials = createProxyCredentials()
  const startProxy = deps.startProxy ?? startLoopbackProxy
  const proxies = new Map<string, Promise<LoopbackProxy>>()
  const ports = new Set<number>()
  const prepared = new Set<string>()
  const dialers = new Map<string, LoopbackDialer[]>()
  // False once any connection to the runtime said it does not reach this
  // machine's network: the private ranges stay refused for that runtime.
  const reaches = new Map<string, boolean>()
  const configuring = new Map<string, Promise<void>>()
  const configured = new Map<string, string>()

  const dialLoopback = async (runtimeId: string, port: number): Promise<ByteDuplex> => {
    const live = (dialers.get(runtimeId) ?? []).filter((d) => !d.isDestroyed())
    dialers.set(runtimeId, live)
    if (live.length === 0) throw new Error(`no window is connected to runtime ${runtimeId}`)
    let lastError: unknown
    for (const dialer of live) {
      try { return await dialer.dial(runtimeId, port) } catch (error) { lastError = error }
    }
    throw lastError
  }

  const ensureProxy = (runtimeId: string): Promise<LoopbackProxy> => {
    let proxy = proxies.get(runtimeId)
    if (!proxy) {
      proxy = (async () => {
        const started = await startProxy({
          credentials,
          upstream: deps.upstream,
          reachesClientNetwork: () => reaches.get(runtimeId) === true,
          dialLoopback: (port) => dialLoopback(runtimeId, port),
        })
        ports.add(started.port)
        return started
      })()
      proxies.set(runtimeId, proxy)
      proxy.catch(() => proxies.delete(runtimeId))
    }
    return proxy
  }

  const prepare = (runtimeId: string): Promise<void> => {
    // Serialize settings changes and stricter connection policies. A later
    // caller must never inherit an in-flight, less restrictive configuration.
    const task = (configuring.get(runtimeId) ?? Promise.resolve()).catch(() => {}).then(async () => {
      const partition = workspacePartition(runtimeId)
      const session = deps.session(partition)
      for (;;) {
        const native = reaches.get(runtimeId) === true
        const upstream = deps.upstream()
        const key = JSON.stringify([native, upstream ?? ''])
        if (configured.get(runtimeId) === key && prepared.has(partition)) return
        prepared.delete(partition)
        const proxy = native ? null : await ensureProxy(runtimeId)
        await session.setProxy(proxy ? {
          mode: 'fixed_servers',
          proxyRules: `http://127.0.0.1:${proxy.port}`,
          proxyBypassRules: '<-loopback>',
        } : browserProxyConfig(upstream))
        // Do not reuse direct sockets after a policy downgrade, or sockets to
        // a previous upstream proxy after a settings change.
        if (configured.has(runtimeId)) await session.closeAllConnections()
        configured.set(runtimeId, key)
        // Policy or settings may have changed during setProxy. Finish applying
        // them before allowing even the first caller to mount a webview.
        if (native !== (reaches.get(runtimeId) === true) || upstream !== deps.upstream()) continue
        prepared.add(partition)
        log.info('partition %s uses %s networking', partition, proxy ? 'protected workspace proxy' : 'Chromium')
        return
      }
    })
    configuring.set(runtimeId, task)
    return task
  }

  return {
    credentials,
    async partitionFor(runtimeId, dialer, reachesClientNetwork) {
      if (!isRuntimeId(runtimeId)) throw new Error('invalid runtime id')
      reaches.set(runtimeId, (reaches.get(runtimeId) ?? true) && reachesClientNetwork)
      const list = dialers.get(runtimeId) ?? []
      if (!list.some((d) => d.id === dialer.id)) list.push(dialer)
      dialers.set(runtimeId, list)
      await prepare(runtimeId)
      return workspacePartition(runtimeId)
    },
    release(runtimeId, dialerId) {
      const list = dialers.get(runtimeId)
      if (list) dialers.set(runtimeId, list.filter((d) => d.id !== dialerId))
    },
    releaseDialer(dialerId) {
      for (const [runtimeId, list] of dialers) dialers.set(runtimeId, list.filter((d) => d.id !== dialerId))
    },
    isPrepared: (partition) => prepared.has(partition),
    refresh: async () => { await Promise.all([...reaches.keys()].map(prepare)) },
    credentialsFor(host, port) {
      if (host === '127.0.0.1' && ports.has(port)) return credentials
      const upstream = authenticatedBrowserProxy(deps.upstream())
      return upstream?.host === host && upstream.port === port ? upstream.credentials : null
    },
    async close() {
      await Promise.allSettled(configuring.values())
      const all = [...proxies.values()]
      proxies.clear()
      await Promise.allSettled(all.map(async (p) => (await p).close()))
    },
  }
}
