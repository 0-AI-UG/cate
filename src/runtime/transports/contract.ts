// runtime/transports contract. Every transport carries the same frames
// (architecture 7.8); how it frames them differs.

export type TransportKind = 'local' | 'network'

/** Sockets carry a byte stream and need length prefixes; WebSocket and WebRTC
 *  carry one frame per message. The argument to `framePortOver`. */
export const FRAME_MODE = { local: 'stream', network: 'message' } as const satisfies Record<TransportKind, 'stream' | 'message'>

export * from './contract/sameNetwork'
export * from './contract/webSocket'
export * from './contract/webrtc'
export * from './contract/secure'
