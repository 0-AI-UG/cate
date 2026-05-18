// Shared helpers used by every Phase D handler module.
//
// We DON'T import handlers from each other (each is self-contained); this
// file is just for utility functions that don't belong in a single handler.

import * as registry from '../registry'
import { getGraphAware } from '../commands'
import type { OrchRequest } from '../protocol'
import { callRenderer, type RenderVerb } from '../renderBridge'

export interface CallerCtx {
  windowId: number
  ptyId: string
  /** Caller's panelId — always known once the registry has the entry. */
  panelId: string
  /** Caller's canvas node id. May be stale across reloads; the renderer's
   *  fallback uses panelId to re-resolve when this id no longer exists. */
  nodeId: string | null
}

/** Resolve the calling terminal's identity and window. Throws when the caller
 *  isn't a registered Cate terminal — every Phase D command requires this. */
export function requireCaller(req: OrchRequest): CallerCtx {
  if (!req.callerTerminalId) throw new Error('caller terminal is not registered with Cate (CATE_TERMINAL_ID missing)')
  const found = registry.findByPtyId(req.callerTerminalId)
  if (!found) throw new Error('caller terminal is not in the registry yet')
  return {
    windowId: found.windowId,
    ptyId: req.callerTerminalId,
    panelId: found.entry.panelId,
    nodeId: found.entry.nodeId,
  }
}

/** Convenience wrapper around the render bridge that scopes to the caller's window. */
export function callRendererForCaller<T = any>(ctx: CallerCtx, verb: RenderVerb, args?: Record<string, any>): Promise<T> {
  return callRenderer<T>(ctx.windowId, verb, args)
}

/** Look up a terminal by name in the caller's window. Optionally enforce that
 *  the caller is connected to it (mirrors the auth check used by `cate ask`). */
export function resolveTerminalByName(ctx: CallerCtx, name: string, opts: { requireConnection?: boolean } = {}) {
  const target = registry.findByName(ctx.windowId, name)
  if (!target) throw new Error(`no terminal named "${name}" on this canvas`)
  if (!target.ptyId) throw new Error(`terminal "${name}" has not started its PTY yet`)
  if (opts.requireConnection && !registry.isConnected(ctx.windowId, ctx.ptyId, target.ptyId, { graphAware: getGraphAware() })) {
    throw new Error(`not connected to "${name}" — connect the panels on the canvas first`)
  }
  return target
}
