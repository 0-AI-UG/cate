// =============================================================================
// Graph + preset handlers — `cate connect / disconnect / preset list`.
//
// Connect / disconnect mutate the canvasStore via the render bridge so the
// dotted-line UI updates immediately. Authorization: the caller must be
// connected to AT LEAST ONE of the two endpoints (otherwise any terminal
// could wire any pair of unrelated panels together, which we don't want).
// =============================================================================

import { requireCaller, callRendererForCaller } from './_shared'
import * as registry from '../registry'
import { getPresets } from '../presets'
import type { OrchRequest } from '../protocol'

export async function presetListHandle(_req: OrchRequest) {
  const presets = await getPresets()
  return {
    presets: presets.map((p) => ({
      name: p.name,
      command: p.command,
      agentKind: p.agentKind,
      available: p.available === true,
    })),
  }
}

/** Resolve a "name" to a canvas node id. The name can match either a terminal
 *  or a portal (browser panel). Both kinds live in the registry. */
function resolveNameToNodeId(windowId: number, name: string): { nodeId: string; kind: 'terminal' | 'portal' } | null {
  const terminal = registry.findByName(windowId, name)
  if (terminal?.nodeId) return { nodeId: terminal.nodeId, kind: 'terminal' }
  const portal = (registry as any).findPortalByName?.(windowId, name) as { nodeId: string | null; name: string } | null
  if (portal?.nodeId) return { nodeId: portal.nodeId, kind: 'portal' }
  return null
}

export async function connectHandle(req: OrchRequest) {
  const ctx = requireCaller(req)
  const args = (req.args ?? {}) as { from?: string; to?: string }
  const fromName = (args.from ?? '').toString().trim()
  const toName = (args.to ?? '').toString().trim()
  if (!fromName || !toName) throw new Error('connect requires both "from" and "to" names')

  const from = resolveNameToNodeId(ctx.windowId, fromName)
  if (!from) throw new Error(`no panel named "${fromName}" on this canvas`)
  const to = resolveNameToNodeId(ctx.windowId, toName)
  if (!to) throw new Error(`no panel named "${toName}" on this canvas`)

  // Caller must already be connected to at least one of the endpoints (or be
  // one of them) so a stray terminal can't rewire panels it has no business
  // touching.
  if (ctx.nodeId && from.nodeId !== ctx.nodeId && to.nodeId !== ctx.nodeId) {
    const state = registry as any
    const adj = state.adjacencyFor?.(ctx.windowId, ctx.nodeId) as Set<string> | undefined
    if (!adj || (!adj.has(from.nodeId) && !adj.has(to.nodeId))) {
      throw new Error('connect requires you to be one of the endpoints, or already connected to one of them')
    }
  }

  const result = await callRendererForCaller<{ connectionId: string }>(ctx, 'createConnection', {
    fromId: from.nodeId,
    toId: to.nodeId,
  })
  return { connectionId: result.connectionId, from: fromName, to: toName }
}

export async function disconnectHandle(req: OrchRequest) {
  const ctx = requireCaller(req)
  const args = (req.args ?? {}) as { from?: string; to?: string }
  const fromName = (args.from ?? '').toString().trim()
  const toName = (args.to ?? '').toString().trim()
  if (!fromName || !toName) throw new Error('disconnect requires both "from" and "to" names')

  const from = resolveNameToNodeId(ctx.windowId, fromName)
  if (!from) throw new Error(`no panel named "${fromName}" on this canvas`)
  const to = resolveNameToNodeId(ctx.windowId, toName)
  if (!to) throw new Error(`no panel named "${toName}" on this canvas`)

  await callRendererForCaller(ctx, 'removeConnection', { fromId: from.nodeId, toId: to.nodeId })
  return { removed: true, from: fromName, to: toName }
}
