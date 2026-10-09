// Page operations on a chat panel's T3 page (`chat.sendText`), which the
// runtime sends to a client with `webview` (architecture 10.2). The chat view
// registers this handler with the client host's surface registry once its
// page is ready.

import type { SurfaceHandler } from '@client/host'
import { t3SendTextScript, type T3Guest } from '@services/t3/client'
import { CHAT_SURFACE_SEND_TEXT } from '@panels/chat/contract'

export function chatSurfaceHandler(guest: T3Guest): SurfaceHandler {
  return async (request) => {
    if (request.op === CHAT_SURFACE_SEND_TEXT) {
      const text = (request.args as { text?: unknown } | undefined)?.text
      if (typeof text !== 'string') throw new Error('text is required')
      return (await guest.executeJavaScript(t3SendTextScript(text))) === true
    }
    throw new Error(`Unknown chat page operation ${request.op}`)
  }
}
