// `ShellTransports` on a phone: network runtimes only, dialed from the page
// with the web view's WebSocket and RTCPeerConnection, mDNS through the
// bridge. A phone runs no runtimes, so there is no local dial.

import type { ShellTransports } from '@client/connections'
import { dialCateConnect } from '@runtime/connect/client'
import { DEFAULT_CATE_CONNECT_URL } from '@runtime/connect/contract'
import type { KnownRuntimes } from '@runtime/pairing/client'
import type { KeyPair } from '@runtime/security/contract'
import { createNetworkDialer } from '@runtime/transports/client'
import type { PeerConnectionFactory, WebSocketFactory } from '@runtime/transports/contract'
import type { MobileBridge } from '../contract'

const webSocket: WebSocketFactory = (url) => new WebSocket(url) as never
const createPeer: PeerConnectionFactory = (config) => new RTCPeerConnection(config) as never

export interface MobileTransportDeps {
  bridge: MobileBridge
  deviceKeys: KeyPair
  deviceName: string
  pins: KnownRuntimes
}

export function createMobileShellTransports(deps: MobileTransportDeps): ShellTransports {
  const network = createNetworkDialer({
    deviceKeys: () => deps.deviceKeys,
    deviceName: () => deps.deviceName,
    pins: deps.pins,
    webSocket,
    discover: (runtimeId, signal) => signal.aborted
      ? Promise.resolve([])
      : deps.bridge('mdns.discover', { runtimeId, timeoutMs: 3_000 }),
    cateConnect: (runtimeId) => dialCateConnect({ url: DEFAULT_CATE_CONNECT_URL, runtimeId, webSocket, createPeer }),
  })
  return {
    dialLocal: () => Promise.reject(new Error('A phone has no local runtimes')),
    dialLoopbackTcp: () => Promise.reject(new Error('A phone has no local ports')),
    dialNetwork: (target) => network.dialNetwork(target),
    pair: (link) => network.pair({ link }),
  }
}
