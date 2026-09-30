// WebRTC from Node through `node-datachannel`, loaded on first use: it is a
// native addon, and a runtime without network access never needs it.

import type { PeerConnectionFactory, PeerConnectionLike } from '../contract'

let loading: Promise<PeerConnectionFactory> | null = null

export function loadNodePeerConnection(): Promise<PeerConnectionFactory> {
  loading ??= import('node-datachannel/polyfill').then((module) => {
    const RTCPeerConnection = module.RTCPeerConnection
    const factory: PeerConnectionFactory = (config) => new RTCPeerConnection(config) as unknown as PeerConnectionLike
    return factory
  }).catch((error: unknown) => {
    loading = null
    throw error
  })
  return loading
}
