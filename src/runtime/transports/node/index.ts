export { dialLocal, dialLocalRetrying, socketDuplex, type DialOptions } from './local'
export {
  advertiseRuntime,
  discoverRuntime,
  lanAddresses,
  nodeWebSocketFactory,
  type Advertisement,
  type DiscoverOptions,
} from './sameNetwork'
export { loadNodePeerConnection } from './webrtc'
