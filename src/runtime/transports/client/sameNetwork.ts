// Client side of the same-network transport. Portable: the WebSocket comes
// from the shell (the browser's own, or `ws` on desktop) and so does mDNS.

import type { MessagePortLike } from '../../security/contract'
import { openWebSocket, sameNetworkUrl, type WebSocketFactory } from '../contract'

export interface SameNetworkDialOptions {
  runtimeId: string
  /** Addresses from the pairing payload or remembered from the last connection. */
  addresses?: readonly string[]
  /** mDNS lookup by runtimeId, when the platform has it. */
  discover?: (runtimeId: string, signal: AbortSignal) => Promise<string[]>
  webSocket: WebSocketFactory
  timeoutMs?: number
}

export class SameNetworkUnreachableError extends Error {}

/**
 * Dials every known address and every discovered one at once; the first to
 * open wins and the rest are closed. The runtime's key is checked after this,
 * by the security layer.
 */
export function dialSameNetwork(options: SameNetworkDialOptions): Promise<MessagePortLike> {
  const timeoutMs = options.timeoutMs ?? 8_000
  return new Promise((resolve, reject) => {
    const abort = new AbortController()
    const tried = new Set<string>()
    const errors: string[] = []
    let inFlight = 0
    let discovering = false
    let settled = false

    const settle = (port: MessagePortLike | Error) => {
      if (settled) {
        if (!(port instanceof Error)) port.close()
        return
      }
      settled = true
      clearTimeout(timer)
      abort.abort()
      if (port instanceof Error) reject(port)
      else resolve(port)
    }
    const giveUpIfDone = () => {
      if (inFlight === 0 && !discovering) {
        settle(new SameNetworkUnreachableError(
          errors.length > 0
            ? `could not reach the workspace on this network (${errors.join('; ')})`
            : 'could not find the workspace on this network',
        ))
      }
    }
    const dial = (address: string) => {
      if (settled || tried.has(address)) return
      tried.add(address)
      const url = sameNetworkUrl(address, options.runtimeId)
      if (!url) return
      inFlight++
      openWebSocket(options.webSocket, url, timeoutMs).then(
        (port) => settle(port),
        (error: Error) => {
          inFlight--
          errors.push(error.message)
          giveUpIfDone()
        },
      )
    }
    const timer = setTimeout(() => settle(new SameNetworkUnreachableError('timed out looking for the workspace on this network')), timeoutMs)

    for (const address of options.addresses ?? []) dial(address)
    if (options.discover) {
      discovering = true
      options.discover(options.runtimeId, abort.signal).then(
        (found) => {
          discovering = false
          for (const address of found) dial(address)
          giveUpIfDone()
        },
        () => {
          discovering = false
          giveUpIfDone()
        },
      )
    } else {
      giveUpIfDone()
    }
  })
}
