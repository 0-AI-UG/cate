// Reaching a paired runtime over the network, and pairing with a new one
// (architecture 7.5 to 7.7): same network first (known addresses and mDNS),
// then Cate Connect, then the security layer with this device's key and the
// pinned runtime key. Portable: each shell passes its WebSocket, its mDNS
// lookup and its Cate Connect dial, and runs this where its device key lives.

import type { ByteDuplex } from '@kernel/rpc/contract'
import { decodePairingUri, parsePairingCode, type PairingMode } from '../../pairing/contract'
import type { KnownRuntimes } from '../../pairing/client'
import { secureChannelDuplex, type KeyPair, type MessagePortLike } from '../../security/contract'
import { formatAddress, type WebSocketFactory } from '../contract'
import { dialSameNetwork } from './sameNetwork'
import { openSecureConnection } from './secure'

export type NetworkDialEndpoint =
  | { kind: 'lan'; address: string; port: number }
  | { kind: 'connect' }

export interface NetworkDialTarget {
  runtimeId: string
  endpoints: readonly NetworkDialEndpoint[]
}

export interface NetworkPairResult {
  runtimeId: string
  /** Where the runtime was reached; store them with the paired workspace. */
  addresses: string[]
  mode: PairingMode
  /** The runtime's static key, now pinned. */
  publicKey: Uint8Array
}

export interface NetworkDialerDeps {
  deviceKeys(): KeyPair
  deviceName(): string
  pins: KnownRuntimes
  webSocket: WebSocketFactory
  /** mDNS lookup by runtimeId, when the platform has it. */
  discover?: (runtimeId: string, signal: AbortSignal) => Promise<string[]>
  /** A raw data channel to the runtime through Cate Connect. */
  cateConnect(runtimeId: string): Promise<MessagePortLike>
  /** Seam for tests. */
  sameNetwork?: typeof dialSameNetwork
}

export interface NetworkDialer {
  /** A message pipe to a paired runtime, already inside the security layer. */
  dialNetwork(target: NetworkDialTarget): Promise<ByteDuplex>
  /** Pairs from a `cate://pair` link or a typed code and pins the runtime key. */
  pair(request: { link: string; deviceName?: string }): Promise<NetworkPairResult>
}

export function createNetworkDialer(deps: NetworkDialerDeps): NetworkDialer {
  const sameNetwork = deps.sameNetwork ?? dialSameNetwork

  /** The first raw message port that reaches the runtime. */
  const reach = async (runtimeId: string, addresses: string[], viaConnect: boolean): Promise<{ port: MessagePortLike; via: PairingMode }> => {
    const errors: string[] = []
    try {
      const port = await sameNetwork({ runtimeId, addresses, discover: deps.discover, webSocket: deps.webSocket })
      return { port, via: 'sameNetwork' }
    } catch (error) {
      errors.push((error as Error).message)
    }
    if (viaConnect) {
      try {
        return { port: await deps.cateConnect(runtimeId), via: 'cateConnect' }
      } catch (error) {
        errors.push((error as Error).message)
      }
    }
    throw new Error(errors.join('; '))
  }

  return {
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
