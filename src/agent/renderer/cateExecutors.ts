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
  // Real viewport center in canvas-space: map the center of the canvas container
  // through the current zoom/offset. This is what the user is actually looking at,
  // so new panels land in view (the old centroid-of-all-nodes estimate could drop
  // a panel far off-screen). Fall back to the node centroid only when the canvas
  // container hasn't been measured yet (headless / pre-mount / tests).
  const cs = st.containerSize
  let center: { x: number; y: number }
  if (cs.width > 0 && cs.height > 0) {
    center = st.viewToCanvas({ x: cs.width / 2, y: cs.height / 2 })
  } else if (occupied.length) {
    center = { x: occupied.reduce((s, r) => s + r.x + r.width / 2, 0) / occupied.length, y: occupied.reduce((s, r) => s + r.y + r.height / 2, 0) / occupied.length }
  } else {
    center = { x: 0, y: 0 }
  }
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
  // A terminal `command` is run after the panel mounts (see below) — NOT passed
  // as createTerminal's `initialInput`, which the store drops.
  let pendingTerminalCommand: string | undefined
  switch (type) {
    case 'editor': {
      const path = typeof target.path === 'string' ? target.path : undefined
      panelId = path ? openFileAsPanel(wsId, path) : app.createEditor(wsId)
      if (path && (typeof target.line === 'number')) {
        setPendingReveal(panelId, { line: target.line as number, column: typeof target.column === 'number' ? (target.column as number) : undefined })
      }
      // Convenience: open straight into rendered markdown preview (markdown files only).
      if (target.preview === true) {
        app.setPanelMarkdownPreview(wsId, panelId, true)
      }
      break
    }
    case 'terminal':
      panelId = app.createTerminal(wsId, undefined, undefined, undefined, typeof target.cwd === 'string' ? target.cwd : undefined)
      pendingTerminalCommand = typeof target.command === 'string' && target.command.trim() ? target.command : undefined
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

  // Run the requested command once the freshly-created terminal's PTY is live.
  if (pendingTerminalCommand) {
    await writeToTerminalWhenReady(panelId, pendingTerminalCommand)
  }

  const node = ctx.canvasStore.getState().nodeForPanel(panelId)
  // Focus + center the freshly opened panel so it lands in view. Without this the
  // viewport stayed where it was and a newly-opened panel could appear off-screen
  // (read as "panned to a random location").
  if (node) ctx.canvasStore.getState().focusAndCenter(node)
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

import { computeArrange } from '../../renderer/lib/cateControlLayout'
import { terminalRegistry } from '../../renderer/lib/terminalRegistry'
import { setCateExecutors } from './cateControl'

const SIZE_PRESETS: Record<string, { width: number; height: number }> = {
  small: { width: 400, height: 300 },
  medium: { width: 640, height: 480 },
  large: { width: 960, height: 720 },
}

function requireNode(ctx: CateControlContext, panelId: string): string | null {
  return ctx.canvasStore.getState().nodeForPanel(panelId)
}

/** Send `command` to a terminal panel's PTY, waiting for the PTY to spawn.
 *  A freshly-created terminal needs panel mount + async node-pty spawn before
 *  terminalRegistry has its ptyId, so a single fixed delay is unreliable — poll
 *  until ready (or time out). Returns true once the command was written.
 *  (`appStore.createTerminal`'s `initialInput` arg is intentionally not persisted
 *  to PanelState — it would re-run on session restore — so it can't be used here.) */
async function writeToTerminalWhenReady(panelId: string, command: string, timeoutMs = 6000): Promise<boolean> {
  const data = command.endsWith('\r') || command.endsWith('\n') ? command : command + '\r'
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const ptyId = terminalRegistry.getEntry(panelId)?.ptyId
    if (ptyId) { window.electronAPI.terminalWrite(ptyId, data); return true }
    if (Date.now() >= deadline) return false
    await new Promise((r) => setTimeout(r, 100))
  }
}

export const execFocusPanel: CateExecutor = async (params, ctx) => {
  const panelId = String(params.panelId ?? '')
  const node = requireNode(ctx, panelId)
  if (!node) return fail(`Panel not found on canvas: ${panelId}`)
  ctx.canvasStore.getState().focusAndCenter(node)
  return ok({ focused: panelId })
}

export const execMovePanel: CateExecutor = async (params, ctx) => {
  const panelId = String(params.panelId ?? '')
  if (panelId === ctx.hostPanelId && !params.placement) return fail('Refusing to move the host agent panel without an explicit placement.')
  const node = requireNode(ctx, panelId)
  if (!node) return fail(`Panel not found on canvas: ${panelId}`)
  const { occupied, viewportCenter, nodesByPanel } = readCanvasGeometry(ctx)
  const st = ctx.canvasStore.getState()
  const size = st.nodes[node].size
  const placement = (params.placement ?? {}) as Record<string, unknown>
  const relPanelId = placement.relativeTo === 'self' ? ctx.hostPanelId : (typeof placement.relativeTo === 'string' ? placement.relativeTo : undefined)
  const relativeTo = relPanelId ? nodesByPanel.get(relPanelId)?.rect : undefined
  // Exclude the node being moved from its own obstacle set (by identity, not index).
  const selfRect = nodesByPanel.get(panelId)?.rect
  const obstacles = selfRect ? occupied.filter((r) => r !== selfRect) : occupied
  const rect = computePlacement({ size, relativeTo, position: placement.position as any, occupied: obstacles, viewportCenter })
  st.moveNode(node, { x: rect.x, y: rect.y })
  return ok({ panelId, x: rect.x, y: rect.y })
}

export const execResizePanel: CateExecutor = async (params, ctx) => {
  const panelId = String(params.panelId ?? '')
  const node = requireNode(ctx, panelId)
  if (!node) return fail(`Panel not found on canvas: ${panelId}`)
  let size: { width: number; height: number } | undefined
  if (typeof params.preset === 'string') size = SIZE_PRESETS[params.preset]
  else if (params.size && typeof params.size === 'object') {
    const s = params.size as Record<string, unknown>
    if (typeof s.width === 'number' && typeof s.height === 'number') size = { width: s.width, height: s.height }
  }
  if (!size) return fail('resize requires a valid `preset` (small|medium|large) or `size` {width,height}.')
  ctx.canvasStore.getState().resizeNode(node, size)
  return ok({ panelId, ...size })
}

export const execArrange: CateExecutor = async (params, ctx) => {
  // `layout` tool exposes the style as `style`; accept legacy `layout` too.
  const layout = String(params.style ?? params.layout ?? 'tile') as 'tile' | 'grid' | 'cascade' | 'focus-one'
  const st = ctx.canvasStore.getState()
  const all = Object.values(st.nodes).filter((n: any) => n.panelId !== ctx.hostPanelId) // self-protection
  const requested = Array.isArray(params.panelIds) ? (params.panelIds as string[]) : null
  const targets = requested
    ? all.filter((n: any) => requested.includes(n.panelId))
    : all
  if (!targets.length) return ok({ arranged: 0 })
  // Frame: union viewport of current nodes (canvas-space).
  const minX = Math.min(...targets.map((n: any) => n.origin.x))
  const minY = Math.min(...targets.map((n: any) => n.origin.y))
  const viewport: Rect = { x: minX, y: minY, width: 1200, height: 900 }
  const rects = computeArrange(layout, targets.length, viewport)
  targets.forEach((n: any, i) => {
    st.moveNode(n.id, { x: rects[i].x, y: rects[i].y })
    st.resizeNode(n.id, { width: rects[i].width, height: rects[i].height })
  })
  return ok({ arranged: targets.length, layout })
}

export const execRunInTerminal: CateExecutor = async (params, ctx) => {
  const command = String(params.command ?? '')
  if (!command.trim()) return fail('terminal run requires a non-empty command.')
  const app = useAppStore.getState()
  let panelId = typeof params.panelId === 'string' ? params.panelId : ''
  if (!panelId || params.newPanel) {
    panelId = app.createTerminal(ctx.workspaceId)
  }
  const sent = await writeToTerminalWhenReady(panelId, command)
  if (!sent) return fail(`Terminal ${panelId} did not become ready to receive input (timed out).`)
  return ok({ panelId, command })
}

export const execOpenUrl: CateExecutor = async (params, ctx) => {
  const url = String(params.url ?? '')
  if (!/^(https?|file):\/\//i.test(url)) return fail('browser navigate requires an http(s) or file URL.')
  const app = useAppStore.getState()
  let panelId = typeof params.panelId === 'string' ? params.panelId : ''
  if (!panelId) { panelId = app.createBrowser(ctx.workspaceId, url); return ok({ panelId, url }) }
  app.updatePanelUrl(ctx.workspaceId, panelId, url)
  return ok({ panelId, url })
}

/** Toggle the rendered markdown preview for an open editor panel. The app gates
 *  the actual render to .md files (EditorPanel), so this is a no-op visually for
 *  non-markdown editors but still records the flag. */
export const execSetMarkdownPreview: CateExecutor = async (params, ctx) => {
  const panelId = String(params.panelId ?? '')
  if (!panelId) return fail('panel preview requires a panelId.')
  const app = useAppStore.getState()
  const ws = app.workspaces.find((w: any) => w.id === ctx.workspaceId)
  const panel = ws?.panels?.[panelId]
  if (!panel) return fail(`Panel not found: ${panelId}`)
  if (panel.type !== 'editor') return fail(`Panel ${panelId} is a ${panel.type}; markdown preview applies to editor panels.`)
  const preview = params.preview !== false
  app.setPanelMarkdownPreview(ctx.workspaceId, panelId, preview)
  return ok({ panelId, preview })
}

/** Read the recent buffer (visible screen + scrollback) of a terminal panel as
 *  plain text. Lets an agent inspect command output it ran via terminal run —
 *  the other half of terminal orchestration. Reads straight from the live xterm
 *  buffer; no PTY round-trip. Safe (read-only). */
export const execReadTerminal: CateExecutor = async (params) => {
  const panelId = String(params.panelId ?? '')
  if (!panelId) return fail('terminal read requires a panelId.')
  const entry = terminalRegistry.getEntry(panelId)
  const buffer = (entry as { terminal?: { buffer?: { active?: any } } } | undefined)?.terminal?.buffer?.active
  if (!entry || !buffer) return fail(`No live terminal for panel ${panelId}.`)

  const requested = typeof params.lines === 'number' ? Math.floor(params.lines) : 50
  const maxLines = Math.max(1, Math.min(requested, 1000))
  const total: number = buffer.length ?? 0
  const start = Math.max(0, total - maxLines)
  const collected: string[] = []
  for (let i = start; i < total; i++) {
    const line = buffer.getLine(i)
    collected.push(line ? line.translateToString(true) : '')
  }
  // Drop trailing blank rows (an idle terminal pads the screen with empties).
  while (collected.length && collected[collected.length - 1] === '') collected.pop()
  return ok({ panelId, lineCount: collected.length, text: collected.join('\n') })
}

// ---------------------------------------------------------------------------
// Consolidated op-routers — the agent sees four tools (layout / panel / browser
// / terminal); each dispatches to the focused executors above by `op`. Keeps the
// tool surface (and its token cost) small while preserving per-op behavior +
// self-protection.
// ---------------------------------------------------------------------------

/** Canvas-wide: read the layout (default) or rearrange panels. */
export const execLayout: CateExecutor = async (params, ctx, agentKey) => {
  return String(params.op ?? 'get') === 'arrange'
    ? execArrange(params, ctx, agentKey)
    : execGetLayout(params, ctx, agentKey)
}

/** Single-panel lifecycle/geometry. */
export const execPanel: CateExecutor = async (params, ctx, agentKey) => {
  const op = String(params.op ?? '')
  switch (op) {
    case 'open': return execOpenPanel(params, ctx, agentKey)
    case 'focus': return execFocusPanel(params, ctx, agentKey)
    case 'move': return execMovePanel(params, ctx, agentKey)
    case 'resize': return execResizePanel(params, ctx, agentKey)
    case 'close': return execClosePanel(params, ctx, agentKey)
    case 'preview': return execSetMarkdownPreview(params, ctx, agentKey)
    default:
      return fail(`panel: unknown op "${op}". Expected open|focus|move|resize|close|preview.`)
  }
}

/** Browser content: navigate a browser panel to a url (creates one if needed). */
export const execBrowser: CateExecutor = async (params, ctx, agentKey) => {
  return execOpenUrl(params, ctx, agentKey)
}

export const execTerminal: CateExecutor = async (params, ctx, agentKey) => {
  const op = String(params.op ?? '')
  switch (op) {
    case 'run': return execRunInTerminal(params, ctx, agentKey)
    case 'read': return execReadTerminal(params, ctx, agentKey)
    default:
      return fail(`terminal: unknown op "${op}". Expected run|read.`)
  }
}

// Register the 4-tool surface with the dispatcher. The routers delegate to the
// focused executors above.
setCateExecutors({
  layout: execLayout,
  panel: execPanel,
  browser: execBrowser,
  terminal: execTerminal,
})
