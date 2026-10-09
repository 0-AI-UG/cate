// Network access (architecture 7.5, 7.7), driven by the `runtimeNetwork`
// workspace setting: `sameNetwork` listens on a LAN port and advertises over
// mDNS; `cateConnect` does that too and keeps a registration with Cate
// Connect, so a device on the same network still connects directly. `off`
// closes the listeners and drops every network connection.

import type { Logger } from '@kernel/log/contract'
import type { RuntimeEndpoints } from '@runtime/data/contract'
import { networkIdOf, type KeyPair } from '@runtime/security/contract'
import type { PeerConnectionFactory, WebSocketFactory } from '@runtime/transports/contract'
import {
  serveSameNetwork,
  type NetworkPeers,
  type SameNetworkListener,
  type SameNetworkOptions,
} from '@runtime/transports/runtime'
import { startConnectRegistration, type ConnectRegistration } from '@runtime/connect/runtime'
import type { RuntimeNetwork } from '../contract'

export type NetworkEndpoints = Omit<RuntimeEndpoints, 'local'>

export interface NetworkAccessDeps {
  /** The runtime is on the network under the key's network id. */
  runtimeKeys: KeyPair
  peers: NetworkPeers
  mode(): RuntimeNetwork
  /** Called on any settings change. */
  subscribe(listener: () => void): () => void
  sameNetwork?: Pick<SameNetworkOptions, 'host' | 'port' | 'advertise' | 'addresses'>
  connect: {
    url: string
    webSocket: WebSocketFactory
    peerConnection: () => Promise<PeerConnectionFactory>
  }
  /** runtime.json is rewritten from here. */
  onEndpointsChanged(endpoints: NetworkEndpoints): void
  log?: Logger
}

export interface NetworkAccess {
  /** Resolves once the listeners match the setting. */
  settled(): Promise<void>
  endpoints(): NetworkEndpoints
  /** LAN addresses for the pairing payload; [] with network off. */
  addresses(): string[]
  registration(): ConnectRegistration | null
  dispose(): Promise<void>
}

export function createNetworkAccess(deps: NetworkAccessDeps): NetworkAccess {
  let lan: SameNetworkListener | null = null
  let registration: ConnectRegistration | null = null
  let disposed = false
  let chain: Promise<void> = Promise.resolve()

  const endpoints = (): NetworkEndpoints => ({
    ...(lan ? { sameNetwork: { port: lan.port, addresses: lan.addresses() } } : {}),
    ...(registration ? { cateConnect: { url: deps.connect.url } } : {}),
  })

  const apply = async () => {
    const mode = disposed ? 'off' : deps.mode()
    const before = JSON.stringify(endpoints())
    if (mode === 'off') {
      deps.peers.closeAll()
    }
    if (mode !== 'off' && !lan) {
      try {
        lan = await serveSameNetwork({
          runtimeId: networkIdOf(deps.runtimeKeys.publicKey),
          peers: deps.peers,
          ...deps.sameNetwork,
          onError: (error) => deps.log?.warn('same network: %s', error.message),
        })
        deps.log?.info('listening on the network at port %d', lan.port)
      } catch (error) {
        deps.log?.error('could not listen on the network: %s', (error as Error).message)
      }
    } else if (mode === 'off' && lan) {
      const closing = lan
      lan = null
      await closing.close()
    }
    if (mode === 'cateConnect' && !registration) {
      registration = startConnectRegistration({
        url: deps.connect.url,
        runtimeKeys: deps.runtimeKeys,
        webSocket: deps.connect.webSocket,
        peerConnection: deps.connect.peerConnection,
        onConnection: (port) => void deps.peers.accept(port, { transport: 'cateConnect' }),
        log: deps.log,
      })
    } else if (mode !== 'cateConnect' && registration) {
      registration.close()
      registration = null
      // Its WebRTC sessions go with it, handshakes included.
      deps.peers.close('cateConnect')
    }
    if (JSON.stringify(endpoints()) !== before) deps.onEndpointsChanged(endpoints())
  }

  const reconcile = () => {
    chain = chain.then(apply, apply)
    return chain
  }

  const off = deps.subscribe(() => void reconcile())
  void reconcile()

  return {
    settled: () => chain,
    endpoints,
    addresses: () => lan?.addresses() ?? [],
    registration: () => registration,
    async dispose() {
      off()
      disposed = true
      await reconcile()
      deps.peers.dispose()
    },
  }
}
