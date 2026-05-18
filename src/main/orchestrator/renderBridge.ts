// =============================================================================
// renderBridge — request/response RPC from main → renderer for orchestrator
// commands that mutate the canvas UI (open a panel, close one, create a
// connection, create/edit a note, etc.).
//
// The renderer registers a single listener on `ORCH_RENDER_COMMAND`; it acts
// on the verb, then sends the result back on `ORCH_RENDER_RESPONSE` keyed by
// the request id we generated. Each request has a hard timeout so a hung
// renderer can't block an orchestrator command forever.
// =============================================================================

import { ipcMain } from 'electron'
import {
  ORCH_RENDER_COMMAND,
  ORCH_RENDER_RESPONSE,
} from '../../shared/ipc-channels'
import { sendToWindow, getWindow } from '../windowRegistry'
import log from '../logger'

const REQ_TIMEOUT_MS = 15000

let nextReqId = 1
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>()

export function registerRenderBridge(): void {
  ipcMain.on(ORCH_RENDER_RESPONSE, (_event, payload: { id: number; ok: boolean; data?: any; error?: string }) => {
    const entry = pending.get(payload.id)
    if (!entry) return
    pending.delete(payload.id)
    clearTimeout(entry.timer)
    if (payload.ok) entry.resolve(payload.data)
    else entry.reject(new Error(payload.error ?? 'renderer command failed'))
  })
}

export type RenderVerb =
  | 'openTerminalPanel'
  | 'closePanel'
  | 'createConnection'
  | 'removeConnection'
  | 'createNote'
  | 'readNote'
  | 'writeNote'
  | 'editNote'
  | 'listNotes'
  | 'layoutNodeInfo'
  | 'layoutMoveNode'
  | 'layoutResizeNode'
  | 'layoutFocusNode'
  | 'layoutSetZoom'
  | 'layoutArrange'

export interface RenderRequest {
  id: number
  verb: RenderVerb
  args?: Record<string, any>
}

/** Send a command to a specific window's renderer and await the response. */
export async function callRenderer<T = any>(windowId: number, verb: RenderVerb, args?: Record<string, any>): Promise<T> {
  const win = getWindow(windowId)
  if (!win || win.isDestroyed()) throw new Error('renderer window is not available')
  const id = nextReqId++
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (!pending.has(id)) return
      pending.delete(id)
      reject(new Error(`renderer command "${verb}" timed out`))
    }, REQ_TIMEOUT_MS)
    pending.set(id, { resolve, reject, timer })
    const req: RenderRequest = { id, verb, args }
    try {
      sendToWindow(windowId, ORCH_RENDER_COMMAND, req)
    } catch (e: any) {
      pending.delete(id)
      clearTimeout(timer)
      reject(new Error(`failed to send to renderer: ${e?.message ?? e}`))
      return
    }
    log.debug('Orchestrator: dispatched %s (req=%d) to window=%d', verb, id, windowId)
  })
}
