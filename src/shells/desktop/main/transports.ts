// The raw sockets behind the renderer's `ShellTransports` (architecture 7.5,
// 15). Local runtimes: find or start the workspace's daemon and connect to its
// socket. Network runtimes: the portable network dialer (runtime/transports)
// over Node's WebSocket, mDNS and WebRTC, so the renderer only ever sees a
// message pipe that is already encrypted. The device key never leaves main.

import net from 'node:net'
import type { ByteDuplex } from '@kernel/rpc/contract'
import { createLogger } from '@kernel/log/contract'
import { dialCateConnect } from '@runtime/connect/client'
import { DEFAULT_CATE_CONNECT_URL } from '@runtime/connect/contract'
import type { LocalRuntime } from '@runtime/daemon/desktop'
import type { KnownRuntimes } from '@runtime/pairing/client'
import type { KeyPair, MessagePortLike } from '@runtime/security/contract'
import { createNetworkDialer, type dialSameNetwork } from '@runtime/transports/client'
import { discoverRuntime, loadNodePeerConnection, nodeWebSocketFactory, socketDuplex } from '@runtime/transports/node'
import type { DesktopNetworkTarget, PairResult } from '../contract'

const log = createLogger('transports')

export interface ShellTransportDeps {
  /** Connects to a workspace's runtime, starting it when nothing answers. */
  startLocal(root: string): Promise<LocalRuntime>
  deviceKeys(): KeyPair
  deviceName(): string
  /** known-runtimes.json, through main's device files. */
  pins: KnownRuntimes
  connectUrl?: string
  /** Seams for tests. */
  sameNetwork?: typeof dialSameNetwork
  cateConnect?: (runtimeId: string) => Promise<MessagePortLike>
}

export interface ShellTransportHost {
  dialLocal(root: string): Promise<ByteDuplex>
  /** Starts the workspace's runtime ahead of the first dial (app launch). */
  prestartLocal(root: string): void
  dialLoopbackTcp(port: number): Promise<ByteDuplex>
  dialNetwork(target: DesktopNetworkTarget): Promise<ByteDuplex>
  pair(request: { link: string; deviceName?: string }): Promise<PairResult>
}

export function dialLoopbackTcp(port: number, host = '127.0.0.1'): Promise<ByteDuplex> {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return Promise.reject(new Error(`invalid port ${port}`))
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, host)
    socket.once('connect', () => {
      socket.removeListener('error', reject)
      resolve(socketDuplex(socket))
    })
    socket.once('error', reject)
  })
}

export function createShellTransportHost(deps: ShellTransportDeps): ShellTransportHost {
  const connectUrl = deps.connectUrl ?? process.env.CATE_CONNECT_URL ?? DEFAULT_CATE_CONNECT_URL
  const network = createNetworkDialer({
    deviceKeys: deps.deviceKeys,
    deviceName: deps.deviceName,
    pins: deps.pins,
    webSocket: nodeWebSocketFactory,
    discover: (id, signal) => discoverRuntime(id, { signal }),
    cateConnect: deps.cateConnect ?? (async (runtimeId) => dialCateConnect({
      url: connectUrl,
      runtimeId,
      webSocket: nodeWebSocketFactory,
      createPeer: await loadNodePeerConnection(),
    })),
    ...(deps.sameNetwork ? { sameNetwork: deps.sameNetwork } : {}),
  })

  // One start per root at a time: a dial that finds one in flight waits for
  // it, then connects to the runtime it started instead of spawning another.
  // A failed start fails its waiters too.
  const starting = new Map<string, Promise<LocalRuntime>>()
  async function startLocal(root: string): Promise<LocalRuntime> {
    const pending = starting.get(root)
    if (pending) await pending
    const start = deps.startLocal(root)
    starting.set(root, start)
    try {
      const local = await start
      if (local.started) log.info('started runtime %s for %s', local.runtimeId, local.root)
      return local
    } finally {
      if (starting.get(root) === start) starting.delete(root)
    }
  }

  return {
    async dialLocal(root) {
      return (await startLocal(root)).duplex
    },
    prestartLocal(root) {
      startLocal(root).then(
        (local) => local.duplex.close(),
        (err: Error) => log.warn('could not start the runtime for %s: %s', root, err.message),
      )
    },
    dialLoopbackTcp: (port) => dialLoopbackTcp(port),
    dialNetwork: (target) => network.dialNetwork(target),
    pair: (request) => network.pair(request),
  }
}
