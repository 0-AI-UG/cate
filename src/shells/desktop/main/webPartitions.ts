// Browser partitions and their loopback web proxies (architecture 12.3). One
// partition per workspace runtime (`persist:ws-<runtimeId>`, shared by its
// browser and chat panels), routed through that workspace's proxy with
// `<-loopback>` so Chromium proxies loopback too. The proxy reaches loopback
// ports through a renderer that holds the workspace connection: main asks it
// for a pipe per connection (`dialLoopback` there is the transport's choice).

import type { Session } from 'electron'
import type { ByteDuplex } from '@kernel/rpc/contract'
import { createLogger } from '@kernel/log/contract'
import { isRuntimeId } from '@runtime/data/contract'
import { workspacePartition } from '@services/browser/contract'
import { createProxyCredentials, startLoopbackProxy, type LoopbackProxy, type ProxyCredentials } from './loopbackProxy'

const log = createLogger('web')

export interface LoopbackDialer {
  readonly id: number
  isDestroyed(): boolean
  /** Asks this renderer for a pipe to `port` on the runtime's machine. */
  dial(runtimeId: string, port: number): Promise<ByteDuplex>
}

export interface WebPartitionsDeps {
  session(partition: string): Pick<Session, 'setProxy'>
  /** The client's `browserProxyUrl`. */
  upstream(): string | undefined
  /** Seam for tests. */
  startProxy?: typeof startLoopbackProxy
}

export interface WebPartitions {
  readonly credentials: ProxyCredentials
  /** Prepares the workspace's partition and registers `dialer` for its
   *  loopback requests; the partition name. */
  partitionFor(runtimeId: string, dialer: LoopbackDialer): Promise<string>
  release(runtimeId: string, dialerId: number): void
  /** Drops every registration of a renderer that went away. */
  releaseDialer(dialerId: number): void
  /** True for a workspace partition whose proxy is in place. */
  isPrepared(partition: string): boolean
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
          dialLoopback: (port) => dialLoopback(runtimeId, port),
        })
        ports.add(started.port)
        const partition = workspacePartition(runtimeId)
        await deps.session(partition).setProxy({
          mode: 'fixed_servers',
          proxyRules: `http://127.0.0.1:${started.port}`,
          proxyBypassRules: '<-loopback>',
        })
        prepared.add(partition)
        log.info('partition %s routed through 127.0.0.1:%d', partition, started.port)
        return started
      })()
      proxies.set(runtimeId, proxy)
      proxy.catch(() => proxies.delete(runtimeId))
    }
    return proxy
  }

  return {
    credentials,
    async partitionFor(runtimeId, dialer) {
      if (!isRuntimeId(runtimeId)) throw new Error('invalid runtime id')
      const list = dialers.get(runtimeId) ?? []
      if (!list.some((d) => d.id === dialer.id)) list.push(dialer)
      dialers.set(runtimeId, list)
      await ensureProxy(runtimeId)
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
    credentialsFor: (host, port) => (host === '127.0.0.1' && ports.has(port) ? credentials : null),
    async close() {
      const all = [...proxies.values()]
      proxies.clear()
      await Promise.allSettled(all.map(async (p) => (await p).close()))
    },
  }
}
