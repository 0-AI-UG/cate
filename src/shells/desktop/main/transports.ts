// The raw sockets behind the renderer's `ShellTransports` (architecture 7.5,
// 15). Local runtimes: find or start the workspace's daemon and connect to its
// socket. Network runtimes: same network (WebSocket + mDNS) or Cate Connect
// (WebRTC), then the security layer with this device's key and the pinned
// runtime key, so the renderer only ever sees a message pipe that is already
// encrypted. The device key never leaves main.

import net from 'node:net'
import type { ByteDuplex } from '@kernel/rpc/contract'
import { createLogger } from '@kernel/log/contract'
import { dialCateConnect } from '@runtime/connect/client'
import { DEFAULT_CATE_CONNECT_URL } from '@runtime/connect/contract'
import type { LocalRuntime } from '@runtime/daemon/desktop'
import { KnownRuntimes } from '@runtime/pairing/client'
import { decodePairingUri, parsePairingCode, type PairingMode } from '@runtime/pairing/contract'
import { secureChannelDuplex, type KeyPair, type MessagePortLike } from '@runtime/security/contract'
import { dialSameNetwork, openSecureConnection } from '@runtime/transports/client'
import { formatAddress } from '@runtime/transports/contract'
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
  /** A root dialed locally this session (its files are on this machine). */
  onLocalRoot?(root: string): void
  connectUrl?: string
  /** Seams for tests. */
  sameNetwork?: typeof dialSameNetwork
  cateConnect?: (runtimeId: string) => Promise<MessagePortLike>
}

export interface ShellTransportHost {
  dialLocal(root: string): Promise<ByteDuplex>
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
  const sameNetwork = deps.sameNetwork ?? dialSameNetwork
  const cateConnect = deps.cateConnect ?? (async (runtimeId: string) => dialCateConnect({
    url: connectUrl,
    runtimeId,
    webSocket: nodeWebSocketFactory,
    createPeer: await loadNodePeerConnection(),
  }))

  /** The first raw message port that reaches the runtime. */
  const reach = async (runtimeId: string, addresses: string[], viaConnect: boolean): Promise<{ port: MessagePortLike; via: PairingMode }> => {
    const errors: string[] = []
    try {
      const port = await sameNetwork({
        runtimeId,
        addresses,
        discover: (id, signal) => discoverRuntime(id, { signal }),
        webSocket: nodeWebSocketFactory,
      })
      return { port, via: 'sameNetwork' }
    } catch (error) {
      errors.push((error as Error).message)
    }
    if (viaConnect) {
      try {
        return { port: await cateConnect(runtimeId), via: 'cateConnect' }
      } catch (error) {
        errors.push((error as Error).message)
      }
    }
    throw new Error(errors.join('; '))
  }

  return {
    async dialLocal(root) {
      const local = await deps.startLocal(root)
      deps.onLocalRoot?.(local.root)
      if (local.started) log.info('started runtime %s for %s', local.runtimeId, local.root)
      return local.duplex
    },
    dialLoopbackTcp: (port) => dialLoopbackTcp(port),
    async dialNetwork(target) {
      const addresses = target.endpoints.flatMap((e) => (e.kind === 'lan' ? [formatAddress(e.address, e.port)] : []))
      const viaConnect = target.endpoints.some((e) => e.kind === 'connect')
      const { port } = await reach(target.runtimeId, addresses, viaConnect)
      const { channel } = await openSecureConnection(port, {
        kind: 'connect',
        deviceKeys: deps.deviceKeys(),
        runtimeId: target.runtimeId,
        pins: deps.pins,
      })
      return secureChannelDuplex(channel)
    },
    async pair(request) {
      const link = request.link.trim()
      let runtimeId: string
      let secret: Uint8Array
      let fingerprint: string | undefined
      let addresses: string[] = []
      let mode: PairingMode | undefined
      if (link.startsWith('cate://')) {
        const payload = decodePairingUri(link)
        ;({ runtimeId, secret, fingerprint, addresses, mode } = payload)
      } else {
        ;({ runtimeId, secret } = parsePairingCode(link))
      }
      const { port, via } = await reach(runtimeId, addresses, mode !== 'sameNetwork')
      const { channel } = await openSecureConnection(port, {
        kind: 'pair',
        deviceKeys: deps.deviceKeys(),
        deviceName: request.deviceName?.trim() || deps.deviceName(),
        target: { runtimeId, secret, ...(fingerprint ? { fingerprint } : {}) },
        pins: deps.pins,
      })
      // Pinned now; the workspace connection dials again by key.
      channel.close()
      return { runtimeId, addresses, mode: mode ?? via, publicKey: channel.remoteStatic }
    },
  }
}
