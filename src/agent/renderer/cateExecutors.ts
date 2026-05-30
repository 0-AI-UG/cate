// =============================================================================
// Concrete executors for cate-control actions. Each takes (params, ctx, agentKey)
// and returns a CateControlResponse. Pure-ish: side effects go through appStore /
// canvasStore / terminalRegistry. Geometry comes from cateControlLayout.
// =============================================================================

import type { CateControlResponse } from '../../shared/cateControl'
import type { CateControlContext, CateExecutor } from './cateControl'
import { useAppStore } from '../../renderer/stores/appStore'
import { PANEL_DEFINITIONS } from '../../shared/panels'
import type { PanelType } from '../../shared/types'
import { computePlacement, type Rect } from '../../renderer/lib/cateControlLayout'
import { openFileAsPanel } from '../../renderer/lib/fileRouting'
import { setPendingReveal } from '../../renderer/lib/editorReveal'

const OPENABLE: PanelType[] = ['editor', 'terminal', 'browser', 'git', 'fileExplorer', 'document']

function fail(error: string): CateControlResponse { return { ok: false, error } }
function ok(result?: unknown): CateControlResponse { return { ok: true, result } }

/** Read occupied rects + viewport center from a context's canvas store. */
function readCanvasGeometry(ctx: CateControlContext): { occupied: Rect[]; viewportCenter: { x: number; y: number }; nodesByPanel: Map<string, { nodeId: string; rect: Rect }> } {
  const st = ctx.canvasStore.getState()
  const occupied: Rect[] = []
  const nodesByPanel = new Map<string, { nodeId: string; rect: Rect }>()
  for (const node of Object.values(st.nodes)) {
    const rect: Rect = { x: node.origin.x, y: node.origin.y, width: node.size.width, height: node.size.height }
    occupied.push(rect)
    nodesByPanel.set(node.panelId, { nodeId: node.id, rect })
  }
  // Viewport center in canvas-space ≈ (-offset + screen/2)/zoom; we approximate
  // with the centroid of existing nodes, falling back to origin.
  const center = occupied.length
    ? { x: occupied.reduce((s, r) => s + r.x + r.width / 2, 0) / occupied.length, y: occupied.reduce((s, r) => s + r.y + r.height / 2, 0) / occupied.length }
    : { x: 0, y: 0 }
  return { occupied, viewportCenter: center, nodesByPanel }
}

export const execGetLayout: CateExecutor = async (_params, ctx) => {
  const app = useAppStore.getState()
  const ws = app.workspaces.find((w: any) => w.id === ctx.workspaceId)
  const st = ctx.canvasStore.getState()
  const panels = Object.values(st.nodes).map((node: any) => {
    const panel = ws?.panels?.[node.panelId]
    return {
      panelId: node.panelId,
      type: panel?.type ?? 'unknown',
      title: panel?.title ?? '',
      x: node.origin.x, y: node.origin.y, width: node.size.width, height: node.size.height,
      focused: st.focusedNodeId === node.id,
      isSelf: node.panelId === ctx.hostPanelId,
    }
  })
  return ok({
    workspaceId: ctx.workspaceId,
    viewport: { zoom: st.zoomLevel, offset: st.viewportOffset },
    panels,
  })
}

export const execOpenPanel: CateExecutor = async (params, ctx) => {
  const type = String(params.type ?? '') as PanelType
  if (!OPENABLE.includes(type)) return fail(`Unsupported panel type: ${String(params.type)}`)
  const target = (params.target ?? {}) as Record<string, unknown>
  const app = useAppStore.getState()
  const wsId = ctx.workspaceId

  let panelId: string
  switch (type) {
    case 'editor': {
      const path = typeof target.path === 'string' ? target.path : undefined
      panelId = path ? openFileAsPanel(wsId, path) : app.createEditor(wsId)
      if (path && (typeof target.line === 'number')) {
        setPendingReveal(panelId, { line: target.line as number, column: typeof target.column === 'number' ? (target.column as number) : undefined })
      }
      break
    }
    case 'terminal':
      panelId = app.createTerminal(wsId, typeof target.command === 'string' ? `${target.command}\r` : undefined, undefined, undefined, typeof target.cwd === 'string' ? target.cwd : undefined)
      break
    case 'browser':
      panelId = app.createBrowser(wsId, typeof target.url === 'string' ? target.url : undefined)
      break
    case 'git':
      panelId = app.createGit(wsId)
      break
    case 'fileExplorer':
      panelId = app.createFileExplorer(wsId)
      break
    case 'document':
      panelId = typeof target.path === 'string' ? openFileAsPanel(wsId, target.path) : app.createEditor(wsId)
      break
    default:
      return fail(`Unsupported panel type: ${type}`)
  }

  // Apply semantic placement if requested (move the freshly-created node).
  const placement = (params.placement ?? {}) as Record<string, unknown>
  if (placement.position || placement.relativeTo) {
    const { occupied, viewportCenter, nodesByPanel } = readCanvasGeometry(ctx)
    const size = PANEL_DEFINITIONS[type].defaultSize
    const relPanelId = placement.relativeTo === 'self' ? ctx.hostPanelId : (typeof placement.relativeTo === 'string' ? placement.relativeTo : undefined)
    const relativeTo = relPanelId ? nodesByPanel.get(relPanelId)?.rect : undefined
    const rect = computePlacement({
      size,
      relativeTo,
      position: placement.position as any,
      occupied,
      viewportCenter,
    })
    const node = ctx.canvasStore.getState().nodeForPanel(panelId)
    if (node) {
      ctx.canvasStore.getState().moveNode(node, { x: rect.x, y: rect.y })
    }
  }

  const node = ctx.canvasStore.getState().nodeForPanel(panelId)
  const frame = node ? ctx.canvasStore.getState().nodes[node] : undefined
  return ok({ panelId, x: frame?.origin.x, y: frame?.origin.y, width: frame?.size.width, height: frame?.size.height })
}

export const execClosePanel: CateExecutor = async (params, ctx) => {
  const panelId = String(params.panelId ?? '')
  const app = useAppStore.getState()
  const ws = app.workspaces.find((w: any) => w.id === ctx.workspaceId)
  if (!ws?.panels?.[panelId]) return fail(`Panel not found: ${panelId}`)
  if (panelId === ctx.hostPanelId) return fail('Refusing to close the agent panel hosting this chat.')
  app.closePanel(ctx.workspaceId, panelId)
  return ok({ closed: panelId })
}
