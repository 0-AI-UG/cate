// =============================================================================
// layout handlers — move / resize / focus / zoom / info / arrange.
// Names are resolved on the renderer side (terminals, browsers, sticky notes
// all live in the canvas), so these handlers are thin pass-throughs.
// =============================================================================

import { requireCaller, callRendererForCaller } from './_shared'
import type { OrchRequest } from '../protocol'
import * as registry from '../registry'

type LayoutVerb = 'move' | 'resize' | 'focus' | 'zoom' | 'info' | 'arrange'

export async function layoutHandle(verb: LayoutVerb, req: OrchRequest): Promise<any> {
  const ctx = requireCaller(req)
  const a = (req.args ?? {}) as Record<string, any>

  switch (verb) {
    case 'info': {
      need(a.name, 'layout info: missing name')
      return callRendererForCaller(ctx, 'layoutNodeInfo', { name: a.name })
    }
    case 'move': {
      need(a.name, 'layout move: missing name')
      const args: Record<string, any> = { name: a.name }
      if (typeof a.x === 'number') args.x = a.x
      if (typeof a.y === 'number') args.y = a.y
      if (typeof a.dx === 'number') args.dx = a.dx
      if (typeof a.dy === 'number') args.dy = a.dy
      if (args.x == null && args.y == null && args.dx == null && args.dy == null) {
        throw new Error('layout move: provide --x/--y for absolute, or --dx/--dy for relative')
      }
      return callRendererForCaller(ctx, 'layoutMoveNode', args)
    }
    case 'resize': {
      need(a.name, 'layout resize: missing name')
      const args: Record<string, any> = { name: a.name }
      if (typeof a.width === 'number') args.width = a.width
      if (typeof a.height === 'number') args.height = a.height
      if (args.width == null && args.height == null) {
        throw new Error('layout resize: provide --width and/or --height')
      }
      return callRendererForCaller(ctx, 'layoutResizeNode', args)
    }
    case 'focus': {
      need(a.name, 'layout focus: missing name')
      const args: Record<string, any> = { name: a.name }
      if (typeof a.zoom === 'number') args.zoom = a.zoom
      return callRendererForCaller(ctx, 'layoutFocusNode', args)
    }
    case 'zoom': {
      if (typeof a.level !== 'number') throw new Error('layout zoom: --level <number> required')
      return callRendererForCaller(ctx, 'layoutSetZoom', { level: a.level })
    }
    case 'arrange': {
      const pattern = (a.pattern ?? '').toString()
      if (!['row', 'column', 'grid', 'circle'].includes(pattern)) {
        throw new Error('layout arrange: pattern must be row|column|grid|circle')
      }
      let names: string[] = Array.isArray(a.names) ? a.names.filter((s: any) => typeof s === 'string') : []
      if (names.length === 0) {
        // Default target set: caller + all connected terminal peers (by name).
        const { self, peers } = registry.listForCaller(ctx.windowId, ctx.ptyId, { graphAware: true })
        const selfName = self?.name
        const peerNames = peers.map((p) => p.name)
        names = (selfName ? [selfName, ...peerNames] : peerNames)
      }
      if (names.length === 0) throw new Error('layout arrange: no panels to arrange (pass --names "A,B,C")')
      const args: Record<string, any> = { names, pattern }
      if (typeof a.gap === 'number') args.gap = a.gap
      if (typeof a.cols === 'number') args.cols = a.cols
      if (typeof a.radius === 'number') args.radius = a.radius
      return callRendererForCaller(ctx, 'layoutArrange', args)
    }
  }
}

function need(val: unknown, msg: string): void {
  if (val === undefined || val === null || val === '') throw new Error(msg)
}
