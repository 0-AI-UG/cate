export { connectLoopback, dialLocal, dialLocalRetrying, socketDuplex, type DialOptions } from './local'
export {
  advertiseRuntime,
  discoverRuntime,
  lanAddresses,
  nodeWebSocketFactory,
  sameNetworkProblem,
  type Advertisement,
  type DiscoverOptions,
} from './sameNetwork'
export { loadNodePeerConnection } from './webrtc'
