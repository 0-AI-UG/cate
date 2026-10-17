// The page end of the native bridge.

import type { MobileBridge } from '../contract'

declare global {
  interface Window {
    webkit?: { messageHandlers?: { cate?: { postMessage(message: unknown): Promise<unknown> } } }
  }
}

export function nativeBridge(): MobileBridge {
  const handler = window.webkit?.messageHandlers?.cate
  if (!handler) throw new Error('Not running inside the Cate app')
  return (method, params) => handler.postMessage({ method, params }) as never
}
