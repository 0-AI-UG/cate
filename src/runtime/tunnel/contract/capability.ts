// The `tunnel` host capability (architecture 7.9): a TCP connection to a
// loopback port of the runtime's machine as a flow-controlled byte stream. It
// backs loopback routing and never connects to another host.

import { defineCapability, stream } from '@kernel/rpc/contract'

export const LOOPBACK_HOSTS = ['127.0.0.1', '::1'] as const

export type LoopbackHost = (typeof LOOPBACK_HOSTS)[number]

export function isLoopbackHost(host: unknown): host is LoopbackHost {
  return typeof host === 'string' && (LOOPBACK_HOSTS as readonly string[]).includes(host)
}

export interface TunnelConnectParams {
  port: number
  /** Default: 127.0.0.1, then ::1. Anything but a loopback address is
   *  refused. */
  host?: LoopbackHost
}

/** Emitted once the TCP connection is up; bytes follow in both directions.
 *  The stream ends when either side closes. */
export type TunnelEvent = { kind: 'open' }

export const tunnelCapability = defineCapability('tunnel', {
  streams: {
    connect: stream<TunnelConnectParams, TunnelEvent, void>({ bytes: true }),
  },
})

declare module '@kernel/rpc/contract' {
  interface CapabilityRegistry {
    tunnel: typeof tunnelCapability
  }
}
