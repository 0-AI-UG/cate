// =============================================================================
// orchestratorCommands — handles UI mutation requests dispatched by the
// main-process orchestrator (cate recruit, cate dismiss, cate note,
// cate connect).
//
// Each verb maps to a sequence of zustand actions or returns data from the
// current renderer state. Results are returned to main via the preload
// onOrchCommand bridge, which packages them into the response IPC.
// =============================================================================

import { useAppStore } from '../stores/appStore'
import { useCanvasStore } from '../stores/canvasStore'
import { terminalRegistry } from './terminalRegistry'
import { flushOrchestratorSync } from './orchestratorSync'
import type { CanvasAnnotation } from '../../shared/types'

/** Walk a canvas node's dockLayout tree to determine if it currently hosts a
 *  given panelId. Used as a stale-nodeId fallback when the main-process
 *  orchestrator passes us a `connectToNodeId` from a previous session that
 *  no longer exists in canvasStore. */
function nodeHostsPanel(node: any, panelId: string): boolean {
  if (!node) return false
  const layout = node.dockLayout as any
  const walk = (n: any): boolean => {
    if (!n) return false
    if (n.type === 'tabs' && Array.isArray(n.panelIds)) return n.panelIds.includes(panelId)
    if (Array.isArray(n.children)) return n.children.some(walk)
    return false
  }
  return walk(layout) || (node as any).panelId === panelId
}

/** Resolve the caller's canvas node id, preferring the explicitly-passed id
 *  but falling back to a panelId-based search of the live canvas. */
function resolveCallerNodeId(args: { connectToNodeId?: string; connectToPanelId?: string }): string | null {
  const canvas = useCanvasStore.getState()
  if (args.connectToNodeId && canvas.nodes[args.connectToNodeId]) return args.connectToNodeId
  if (args.connectToPanelId) {
    for (const n of Object.values(canvas.nodes)) {
      if (nodeHostsPanel(n, args.connectToPanelId)) return n.id
    }
  }
  return null
}

interface Req { id: number; verb: string; args?: any }

export function registerOrchestratorCommandHandler(): void {
  const api = (window as any).electronAPI
  if (!api?.onOrchCommand) return
  api.onOrchCommand((req: Req) => dispatch(req))
}

// openTerminalPanel identifies the just-created panel by diffing
// workspace.panels before/after createTerminal — running two in parallel
// makes the diff ambiguous (each call sees the other's panel in "after" and
// can claim it). Serialize spawn-style verbs so parallel `cate recruit`
// calls always pick the right panelId.
let spawnQueue: Promise<unknown> = Promise.resolve()
function serializeSpawn<T>(run: () => Promise<T> | T): Promise<T> {
  const next = spawnQueue.then(() => run())
  // Don't let one failure poison subsequent calls.
  spawnQueue = next.catch(() => {})
  return next
}

async function dispatch(req: Req): Promise<any> {
  switch (req.verb) {
    case 'openTerminalPanel': return serializeSpawn(() => openTerminalPanel(req.args))
    case 'closePanel':        return closePanel(req.args)
    case 'createConnection':  return createConnection(req.args)
    case 'removeConnection':  return removeConnection(req.args)
    case 'createNote':        return serializeSpawn(() => createNote(req.args))
    case 'readNote':          return readNote(req.args)
    case 'writeNote':         return writeNote(req.args)
    case 'editNote':          return editNote(req.args)
    case 'listNotes':         return listNotes(req.args)
    case 'layoutNodeInfo':    return layoutNodeInfo(req.args)
    case 'layoutMoveNode':    return layoutMoveNode(req.args)
    case 'layoutResizeNode':  return layoutResizeNode(req.args)
    case 'layoutFocusNode':   return layoutFocusNode(req.args)
    case 'layoutSetZoom':     return layoutSetZoom(req.args)
    case 'layoutArrange':     return layoutArrange(req.args)
    default: throw new Error(`unknown orchestrator verb: ${req.verb}`)
  }
}

// ---------------------------------------------------------------------------
// Terminals
// ---------------------------------------------------------------------------

/** Open a new terminal panel on the active workspace's canvas, set its title,
 *  and (optionally) auto-connect it to the caller. Returns identifiers so the
 *  orchestrator can wire up env / type the agent kickoff. */
function openTerminalPanel(args: { name: string; cwd?: string; connectToNodeId?: string; connectToPanelId?: string }) {
  const app = useAppStore.getState()
  const wsId = app.selectedWorkspaceId
  if (!wsId) throw new Error('no active workspace')

  // Resolve the caller's *current* canvas node id (defensive against stale ids
  // from earlier sessions or registry drift). Prefer explicit nodeId; fall
  // back to walking canvas.nodes for the caller's panelId.
  const liveCallerNodeId = resolveCallerNodeId(args)

  // Fan recruits out around the caller so they land as fresh canvas nodes and
  // each one's connection wire gets its own clean route, instead of every
  // recruit stacking on top of the master. Index = current peer count for the
  // caller node (so successive recruits don't collide with earlier ones).
  let position: { x: number; y: number } | undefined
  if (liveCallerNodeId) {
    const canvas = useCanvasStore.getState()
    const caller = canvas.nodes[liveCallerNodeId]
    if (caller) {
      const callerCount = Object.values(canvas.connections).filter(
        (c) => c.from === liveCallerNodeId || c.to === liveCallerNodeId,
      ).length
      // Place on a circle around the caller — fans out at 50° steps with a
      // small radius growth so the Nth recruit is reachable without overlap.
      const angleDeg = -20 + callerCount * 50
      const angleRad = (angleDeg * Math.PI) / 180
      const radius = Math.max(caller.size.width, caller.size.height) + 220 + callerCount * 60
      const callerCx = caller.origin.x + caller.size.width / 2
      const callerCy = caller.origin.y + caller.size.height / 2
      // Default recruit size; new canvas panels will resize themselves but we
      // need a center-of-rect offset to avoid clipping against the caller.
      const halfW = 320
      const halfH = 240
      position = {
        x: Math.round(callerCx + Math.cos(angleRad) * radius - halfW),
        y: Math.round(callerCy + Math.sin(angleRad) * radius - halfH),
      }
    }
  }

  // createTerminal returns void in some shapes; we look up the resulting panel
  // after the call by scanning for one we didn't have before.
  const wsBefore = app.workspaces.find((w) => w.id === wsId)
  const beforeIds = new Set(Object.keys(wsBefore?.panels ?? {}))
  app.createTerminal(wsId, undefined, position, undefined)
  const wsAfter = useAppStore.getState().workspaces.find((w) => w.id === wsId)
  const newPanelId = Object.keys(wsAfter?.panels ?? {}).find((id) => !beforeIds.has(id))
  if (!newPanelId) throw new Error('failed to spawn terminal panel')

  // Rename to the requested display name.
  if (args.name) {
    useAppStore.getState().updatePanelTitle(wsId, newPanelId, args.name)
  }

  // Find the canvas node hosting the panel. createTerminal also placePanel's
  // the panel into the canvas / dock — we need a tick before the node exists.
  // We let the renderer settle for one event loop turn before reporting back.
  return new Promise<{ panelId: string; nodeId: string | null }>((resolve) => {
    let attempts = 0
    const tick = () => {
      const canvas = useCanvasStore.getState()
      let foundNode: string | null = null
      for (const node of Object.values(canvas.nodes)) {
        const layout = node.dockLayout as any
        const hasPanel = (n: any): boolean => {
          if (!n) return false
          if (n.type === 'tabs' && Array.isArray(n.panelIds)) return n.panelIds.includes(newPanelId)
          if (Array.isArray(n.children)) return n.children.some(hasPanel)
          return false
        }
        if (hasPanel(layout) || (node as any).panelId === newPanelId) {
          foundNode = node.id
          break
        }
      }
      if (foundNode) {
        if (liveCallerNodeId) {
          try { useCanvasStore.getState().addConnection(liveCallerNodeId, foundNode) }
          catch { /* node may already be removed */ }
        }
        // Force an immediate orchestrator-registry push so the very next
        // `cate ask` / `cate check` sees this new node + connection, instead
        // of racing the 100ms debounce.
        flushOrchestratorSync().finally(() => {
          resolve({ panelId: newPanelId, nodeId: foundNode })
        })
        return
      }
      if (++attempts > 30) {
        // Give up after ~600 ms; still return what we have so the orchestrator
        // can at least proceed without auto-connect.
        flushOrchestratorSync().finally(() => {
          resolve({ panelId: newPanelId, nodeId: null })
        })
        return
      }
      setTimeout(tick, 20)
    }
    setTimeout(tick, 10)
  })
}

function closePanel(args: { panelId: string }) {
  const app = useAppStore.getState()
  const wsId = app.selectedWorkspaceId
  if (!wsId) throw new Error('no active workspace')
  // Use the canvas op to remove the node; appStore.closePanel handles dock removal too.
  const closeFn = (app as any).closePanel ?? (app as any).removePanel
  if (typeof closeFn === 'function') {
    closeFn(wsId, args.panelId)
    return { closed: true }
  }
  // Fallback: drop from workspace.panels directly.
  useAppStore.setState((state) => ({
    workspaces: state.workspaces.map((ws) =>
      ws.id === wsId
        ? { ...ws, panels: Object.fromEntries(Object.entries(ws.panels).filter(([id]) => id !== args.panelId)) }
        : ws,
    ),
  }))
  return { closed: true }
}

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

async function createConnection(args: { fromId: string; toId: string }) {
  const id = useCanvasStore.getState().addConnection(args.fromId, args.toId)
  if (!id) throw new Error('failed to create connection (endpoints invalid or same node)')
  await flushOrchestratorSync()
  return { connectionId: id }
}

async function removeConnection(args: { connectionId?: string; fromId?: string; toId?: string }) {
  const state = useCanvasStore.getState()
  let id = args.connectionId
  if (!id && args.fromId && args.toId) {
    for (const c of Object.values(state.connections)) {
      if ((c.from === args.fromId && c.to === args.toId) || (c.from === args.toId && c.to === args.fromId)) {
        id = c.id
        break
      }
    }
  }
  if (!id) throw new Error('no matching connection')
  state.removeConnection(id)
  await flushOrchestratorSync()
  return { removed: true }
}

// ---------------------------------------------------------------------------
// Notes — operate on canvasStore.annotations of type 'stickyNote'.
// Name lookup: case-insensitive match against the annotation's first line.
// ---------------------------------------------------------------------------

function firstLineName(content: string): string {
  const line = content.split('\n').find((l) => l.trim().length > 0)
  return (line ?? 'Untitled').trim().slice(0, 80)
}

function findNoteByName(name: string): CanvasAnnotation | null {
  const annotations = useCanvasStore.getState().annotations
  const needle = name.trim().toLowerCase()
  for (const a of Object.values(annotations)) {
    if (a.type !== 'stickyNote') continue
    if (firstLineName(a.content).toLowerCase() === needle) return a
  }
  return null
}

async function createNote(args: { content?: string; connectToNodeId?: string; connectToPanelId?: string; origin?: { x: number; y: number } }) {
  // Pick an origin near the caller's node if provided, else a default offset.
  const canvas = useCanvasStore.getState()
  const callerNodeId = resolveCallerNodeId(args)
  let origin = args.origin
  if (!origin && callerNodeId) {
    const node = canvas.nodes[callerNodeId]
    if (node) origin = { x: node.origin.x - 220, y: node.origin.y }
  }
  if (!origin) origin = { x: 100, y: 100 }
  const id = useCanvasStore.getState().addAnnotation('stickyNote', origin, args.content ?? '')
  if (callerNodeId) {
    try { useCanvasStore.getState().addConnection(callerNodeId, id) } catch { /* fine */ }
  }
  await flushOrchestratorSync()
  const created = useCanvasStore.getState().annotations[id]
  return { annotationId: id, name: firstLineName(created?.content ?? '') }
}

function readNote(args: { name: string; startLine?: number; numLines?: number }) {
  const note = findNoteByName(args.name)
  if (!note) throw new Error(`no note named "${args.name}"`)
  const allLines = note.content.split('\n')
  let lines = allLines
  if (typeof args.startLine === 'number') {
    const start = Math.max(0, args.startLine - 1)
    const end = typeof args.numLines === 'number' ? start + args.numLines : allLines.length
    lines = allLines.slice(start, end)
  }
  const numbered = lines.map((l, i) => {
    const lineNumber = (typeof args.startLine === 'number' ? args.startLine : 1) + i
    return `${lineNumber.toString().padStart(4, ' ')} | ${l}`
  })
  return { name: firstLineName(note.content), content: numbered.join('\n') }
}

function writeNote(args: { name: string; content: string }) {
  const note = findNoteByName(args.name)
  if (!note) throw new Error(`no note named "${args.name}"`)
  useCanvasStore.getState().updateAnnotation(note.id, args.content)
  const updated = useCanvasStore.getState().annotations[note.id]
  return { name: firstLineName(updated?.content ?? ''), bytes: args.content.length }
}

function editNote(args: { name: string; oldText: string; newText: string }) {
  const note = findNoteByName(args.name)
  if (!note) throw new Error(`no note named "${args.name}"`)
  if (!args.oldText) throw new Error('edit: old text is empty')
  if (!note.content.includes(args.oldText)) throw new Error('edit: old text not found in note')
  const occurrences = note.content.split(args.oldText).length - 1
  if (occurrences > 1) throw new Error(`edit: old text appears ${occurrences} times; provide more context to make it unique`)
  const next = note.content.replace(args.oldText, args.newText)
  useCanvasStore.getState().updateAnnotation(note.id, next)
  return { name: firstLineName(next), occurrences }
}

function listNotes(_args: any) {
  const annotations = useCanvasStore.getState().annotations
  const notes = Object.values(annotations)
    .filter((a) => a.type === 'stickyNote')
    .map((a) => ({ id: a.id, name: firstLineName(a.content) }))
  return { notes }
}

// ---------------------------------------------------------------------------
// Layout — move / resize / focus / zoom / arrange canvas nodes by name.
// Resolves names across terminal, browser, and sticky-note panels.
// ---------------------------------------------------------------------------

interface ResolvedNode {
  nodeId: string
  kind: 'terminal' | 'browser' | 'editor' | 'note'
  origin: { x: number; y: number }
  size: { width: number; height: number }
  name: string
}

function resolveNodeByName(name: string): ResolvedNode | null {
  const needle = name.trim().toLowerCase()
  if (!needle) return null
  const app = useAppStore.getState()
  const wsId = app.selectedWorkspaceId
  const ws = wsId ? app.workspaces.find((w) => w.id === wsId) : null
  const canvas = useCanvasStore.getState()

  // 1) Panel match by title (terminal / browser / editor).
  if (ws) {
    for (const p of Object.values(ws.panels)) {
      if ((p.title ?? '').toLowerCase() !== needle) continue
      for (const node of Object.values(canvas.nodes)) {
        if (!nodeHostsPanel(node, p.id)) continue
        return {
          nodeId: node.id,
          kind: (p.type as ResolvedNode['kind']) ?? 'terminal',
          origin: node.origin,
          size: node.size,
          name: p.title,
        }
      }
    }
  }

  // 2) Sticky-note annotation match (first non-empty line).
  for (const a of Object.values(canvas.annotations)) {
    if (a.type !== 'stickyNote') continue
    if (firstLineName(a.content).toLowerCase() !== needle) continue
    return {
      nodeId: a.id,
      kind: 'note',
      origin: a.origin,
      size: a.size ?? { width: 180, height: 140 },
      name: firstLineName(a.content),
    }
  }
  return null
}

function moveAnyById(id: string, origin: { x: number; y: number }): boolean {
  const canvas = useCanvasStore.getState()
  if (canvas.nodes[id]) { canvas.moveNode(id, origin); return true }
  if (canvas.annotations[id]) { canvas.moveAnnotation(id, origin); return true }
  return false
}

function resizeAnyById(id: string, size: { width: number; height: number }): boolean {
  const canvas = useCanvasStore.getState()
  if (canvas.nodes[id]) { canvas.resizeNode(id, size); return true }
  if (canvas.annotations[id]) { canvas.resizeAnnotation(id, size); return true }
  return false
}

function layoutNodeInfo(args: { name: string }) {
  const node = resolveNodeByName(args.name)
  if (!node) throw new Error(`no panel or note named "${args.name}" on the canvas`)
  return {
    name: node.name,
    kind: node.kind,
    nodeId: node.nodeId,
    x: Math.round(node.origin.x),
    y: Math.round(node.origin.y),
    width: Math.round(node.size.width),
    height: Math.round(node.size.height),
  }
}

function layoutMoveNode(args: { name: string; x?: number; y?: number; dx?: number; dy?: number }) {
  const node = resolveNodeByName(args.name)
  if (!node) throw new Error(`no panel or note named "${args.name}" on the canvas`)
  const relative = typeof args.dx === 'number' || typeof args.dy === 'number'
  const next = relative
    ? { x: node.origin.x + (args.dx ?? 0), y: node.origin.y + (args.dy ?? 0) }
    : { x: typeof args.x === 'number' ? args.x : node.origin.x,
        y: typeof args.y === 'number' ? args.y : node.origin.y }
  if (!moveAnyById(node.nodeId, next)) throw new Error('failed to move node')
  return { name: node.name, x: Math.round(next.x), y: Math.round(next.y) }
}

function layoutResizeNode(args: { name: string; width?: number; height?: number }) {
  const node = resolveNodeByName(args.name)
  if (!node) throw new Error(`no panel or note named "${args.name}" on the canvas`)
  const w = typeof args.width === 'number' ? Math.max(80, args.width) : node.size.width
  const h = typeof args.height === 'number' ? Math.max(60, args.height) : node.size.height
  if (!resizeAnyById(node.nodeId, { width: w, height: h })) throw new Error('failed to resize node')
  return { name: node.name, width: Math.round(w), height: Math.round(h) }
}

function layoutFocusNode(args: { name: string; zoom?: number }) {
  const node = resolveNodeByName(args.name)
  if (!node) throw new Error(`no panel or note named "${args.name}" on the canvas`)
  const canvas = useCanvasStore.getState()
  const cs = canvas.containerSize
  const cw = cs?.width || window.innerWidth
  const ch = cs?.height || window.innerHeight
  const zoom = typeof args.zoom === 'number' ? Math.max(0.1, Math.min(args.zoom, 4)) : canvas.zoomLevel
  const cx = node.origin.x + node.size.width / 2
  const cy = node.origin.y + node.size.height / 2
  canvas.setZoomAndOffset(zoom, { x: cw / 2 - cx * zoom, y: ch / 2 - cy * zoom })
  return { name: node.name, zoom, centerX: Math.round(cx), centerY: Math.round(cy) }
}

function layoutSetZoom(args: { level: number }) {
  if (typeof args.level !== 'number' || !isFinite(args.level)) throw new Error('zoom level must be a number')
  const canvas = useCanvasStore.getState()
  const cs = canvas.containerSize
  const cw = cs?.width || window.innerWidth
  const ch = cs?.height || window.innerHeight
  const clamped = Math.max(0.1, Math.min(args.level, 4))
  // Hold canvas point under viewport center stable while we rezoom.
  const old = canvas.zoomLevel
  const canvasCx = (cw / 2 - canvas.viewportOffset.x) / old
  const canvasCy = (ch / 2 - canvas.viewportOffset.y) / old
  canvas.setZoomAndOffset(clamped, { x: cw / 2 - canvasCx * clamped, y: ch / 2 - canvasCy * clamped })
  return { zoom: clamped }
}

function layoutArrange(args: {
  names: string[]
  pattern: 'row' | 'column' | 'grid' | 'circle'
  gap?: number
  cols?: number
  radius?: number
  anchor?: { x: number; y: number }
}) {
  const list = (args.names ?? []).map((n) => resolveNodeByName(n)).filter((n): n is ResolvedNode => !!n)
  if (list.length === 0) throw new Error('arrange: no matching panels')
  const gap = typeof args.gap === 'number' ? args.gap : 60
  const anchor = args.anchor ?? { x: list[0].origin.x, y: list[0].origin.y }

  const placed: Array<{ name: string; x: number; y: number }> = []
  if (args.pattern === 'row') {
    let x = anchor.x
    for (const n of list) {
      moveAnyById(n.nodeId, { x, y: anchor.y })
      placed.push({ name: n.name, x: Math.round(x), y: Math.round(anchor.y) })
      x += n.size.width + gap
    }
  } else if (args.pattern === 'column') {
    let y = anchor.y
    for (const n of list) {
      moveAnyById(n.nodeId, { x: anchor.x, y })
      placed.push({ name: n.name, x: Math.round(anchor.x), y: Math.round(y) })
      y += n.size.height + gap
    }
  } else if (args.pattern === 'grid') {
    const cols = Math.max(1, args.cols ?? Math.ceil(Math.sqrt(list.length)))
    const colW = Math.max(...list.map((n) => n.size.width))
    const rowH = Math.max(...list.map((n) => n.size.height))
    list.forEach((n, i) => {
      const col = i % cols
      const row = Math.floor(i / cols)
      const x = anchor.x + col * (colW + gap)
      const y = anchor.y + row * (rowH + gap)
      moveAnyById(n.nodeId, { x, y })
      placed.push({ name: n.name, x: Math.round(x), y: Math.round(y) })
    })
  } else if (args.pattern === 'circle') {
    const maxDim = Math.max(...list.map((n) => Math.max(n.size.width, n.size.height)))
    const radius = typeof args.radius === 'number' ? args.radius : Math.max(300, list.length * (maxDim / 4 + gap))
    const cx = anchor.x
    const cy = anchor.y
    list.forEach((n, i) => {
      const angle = (i / list.length) * Math.PI * 2 - Math.PI / 2
      const x = cx + Math.cos(angle) * radius - n.size.width / 2
      const y = cy + Math.sin(angle) * radius - n.size.height / 2
      moveAnyById(n.nodeId, { x, y })
      placed.push({ name: n.name, x: Math.round(x), y: Math.round(y) })
    })
  } else {
    throw new Error(`unknown arrange pattern: ${args.pattern}`)
  }
  return { pattern: args.pattern, placed }
}

