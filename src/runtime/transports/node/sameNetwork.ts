// Same network from Node: the `ws` WebSocket for the desktop shell and mDNS
// (`_cate._tcp`, runtimeId in the TXT record) for advertising and discovery.

import os from 'node:os'
import { Bonjour, type Service } from 'bonjour-service'
import WebSocket from 'ws'
import {
  formatAddress,
  MDNS_RUNTIME_ID_KEY,
  MDNS_SERVICE_TYPE,
  NETWORK_MAX_MESSAGE,
  type WebSocketFactory,
  type WebSocketLike,
} from '../contract'

/** Node's `ws` as the client core's WebSocket. */
export const nodeWebSocketFactory: WebSocketFactory = (url) =>
  new WebSocket(url, { maxPayload: NETWORK_MAX_MESSAGE }) as unknown as WebSocketLike

/** This machine's LAN addresses: non-internal IPv4, or IPv6 (not link-local)
 *  when there is no IPv4. Few addresses keep the pairing QR code small. */
export function lanAddresses(port: number): string[] {
  const v4: string[] = []
  const v6: string[] = []
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.internal) continue
      if (entry.family === 'IPv4') v4.push(formatAddress(entry.address, port))
      else if (!entry.address.toLowerCase().startsWith('fe80')) v6.push(formatAddress(entry.address, port))
    }
  }
  return v4.length > 0 ? v4 : v6
}

export interface Advertisement {
  stop(): Promise<void>
}

export function advertiseRuntime(options: { runtimeId: string; port: number; onError?: (error: Error) => void }): Advertisement {
  const bonjour = new Bonjour({}, (error: Error) => options.onError?.(error))
  const service = bonjour.publish({
    name: `cate-${options.runtimeId}`,
    type: MDNS_SERVICE_TYPE,
    port: options.port,
    txt: { [MDNS_RUNTIME_ID_KEY]: options.runtimeId },
  })
  service.on('error', (error: Error) => options.onError?.(error))
  return {
    stop: () => new Promise<void>((resolve) => {
      bonjour.unpublishAll(() => bonjour.destroy(() => resolve()))
    }),
  }
}

export interface DiscoverOptions {
  timeoutMs?: number
  signal?: AbortSignal
}

/** Addresses of the runtime advertising `runtimeId`, or [] when none answers
 *  in time. Resolves on the first answer. */
export function discoverRuntime(runtimeId: string, options: DiscoverOptions = {}): Promise<string[]> {
  return new Promise((resolve) => {
    const bonjour = new Bonjour()
    let done = false
    const finish = (addresses: string[]) => {
      if (done) return
      done = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      browser.stop()
      bonjour.destroy()
      resolve(addresses)
    }
    const onAbort = () => finish([])
    const onUp = (service: Service) => {
      const txt = (service.txt ?? {}) as Record<string, unknown>
      if (String(txt[MDNS_RUNTIME_ID_KEY] ?? '') !== runtimeId) return
      const addresses = (service.addresses ?? []).map((host) => formatAddress(host, service.port))
      if (addresses.length > 0) finish(addresses)
    }
    const browser = bonjour.find({ type: MDNS_SERVICE_TYPE }, onUp)
    const timer = setTimeout(() => finish([]), options.timeoutMs ?? 3_000)
    options.signal?.addEventListener('abort', onAbort)
  })
}
