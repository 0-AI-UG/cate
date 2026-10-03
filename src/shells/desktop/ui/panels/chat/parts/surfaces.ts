// The chat pages this client shows, for page operations the runtime asks the
// driving client to run (`surface` capability). The client's surface router
// hands each chat request to `runChatSurfaceOp`.

import type { SurfaceRequest } from '@panels/framework/contract'
import { t3SendTextScript, type T3Guest } from '@services/t3/client'
import { CHAT_SURFACE_SEND_TEXT } from '@panels/chat/contract'

const guests = new Map<string, T3Guest>()
const key = (workspaceId: string, panelId: string) => `${workspaceId}\u0000${panelId}`

/** A ready page of `panelId`; returns its removal. */
export function registerChatSurface(workspaceId: string, panelId: string, guest: T3Guest): () => void {
  const id = key(workspaceId, panelId)
  guests.set(id, guest)
  return () => { if (guests.get(id) === guest) guests.delete(id) }
}

export async function runChatSurfaceOp(workspaceId: string, request: SurfaceRequest): Promise<unknown> {
  const guest = guests.get(key(workspaceId, request.panelId))
  if (!guest) throw new Error('The chat page is not open on this client.')
  if (request.op === CHAT_SURFACE_SEND_TEXT) {
    const text = (request.args as { text?: unknown } | undefined)?.text
    if (typeof text !== 'string') throw new Error('text is required')
    return (await guest.executeJavaScript(t3SendTextScript(text))) === true
  }
  throw new Error(`Unknown chat page operation ${request.op}`)
}
