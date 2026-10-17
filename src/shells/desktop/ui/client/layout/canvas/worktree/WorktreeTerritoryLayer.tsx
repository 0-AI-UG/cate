// React and canvas glue for the worktree territory. Owns the <canvas>es,
// keeps them sized and DPR-correct, drives a dirty-gated rAF and assembles the
// renderer's inputs (membership, live node geometry, the live drag ghost).
// Drawn in screen space beside the grid, outside the world transform.
//
// The primary path is the WebGL2 fragment renderer: the territory is a pure
// function of world position, so pan, zoom and drag are a uniform update and
// one full-screen draw, full resolution every frame. The CPU `drawTerritory`
// stays as the fallback (no WebGL2, lost context) and the A/B reference.
// localStorage `cate.territory.backend` = 'gl' | 'cpu' forces a backend.

import React, { useEffect, useRef, useState } from 'react'
import type { Point } from '@workspace/canvas/contract'
import { canvasDrag, subscribeCanvasDragPort, type CanvasDragState } from '../ports'
import type { ViewNode } from '../store'
import { useCanvasViewStore } from '../context'
import { useCanvasUi } from '../uiState'
import { useWorktreeMembership, type WorktreeGroup } from './useWorktreeMembership'
import { drawTerritory, type TerritoryGroup } from './territoryRenderer'
import { createTerritoryGL, buildPrimitives, type TerritoryGL } from './territoryGL'
import { buildPocketMask } from './territoryPocketMask'

interface Props {
  workspaceId: string
  containerWidth: number
  containerHeight: number
}

type Backend = 'gl' | 'cpu'

/** The drag layer may publish where the dragged node's ghost is, in canvas
 *  space (null while the cursor is outside the window). Without it the
 *  dragged node's territory drops out for the gesture. */
type TerritoryDragState = CanvasDragState & { ghostOrigin?: Point | null }

/** Coarser field cell for the CPU fallback while a gesture moves. */
const CPU_GESTURE_CELL_SCALE = 2

/** Remounts of a fresh GL canvas after context loss before settling on CPU,
 *  so a permanently gone GPU does not thrash lost, remount, lost. */
const GL_MAX_RECOVERIES = 3

/** Enclosed-pocket fill is a non-local flood fill that per-pixel shading cannot
 *  reproduce cleanly (blocky boundaries, partial fills). It only fills rare
 *  fully enclosed lakes, so the GL path leaves them as clean clearings. */
const ENABLE_POCKET_FILL = false

function forcedBackend(): Backend | null {
  try {
    const v = localStorage.getItem('cate.territory.backend')
    return v === 'cpu' || v === 'gl' ? v : null
  } catch { return null }
}

/** Changes on geometry, colour or membership but not on pan or zoom. Gates
 *  geometry and mask re-upload to the GPU. */
function contentSig(groups: TerritoryGroup[]): number {
  let h = 2166136261 >>> 0
  for (const g of groups) {
    for (let i = 0; i < g.color.length; i++) h = Math.imul(h ^ g.color.charCodeAt(i), 16777619)
    h = Math.imul(h ^ Math.round((g.dim ?? 1) * 100), 16777619)
    for (const rc of g.rects) {
      h = Math.imul(h ^ (rc.x | 0), 16777619)
      h = Math.imul(h ^ (rc.y | 0), 16777619)
      h = Math.imul(h ^ (rc.w | 0), 16777619)
      h = Math.imul(h ^ (rc.h | 0), 16777619)
    }
  }
  return h >>> 0
}

/** The node under a whole-node drag. Its view origin stays put until the drop;
 *  the territory follows the ghost when the drag layer reports it, and drops
 *  the node out otherwise (it is hidden, maybe dragged to another window). */
function dragGhost(): { nodeId: string; origin: Point | null } | null {
  const drag = canvasDrag().getState() as TerritoryDragState
  if (!drag.dragging || !drag.sourceNodeId) return null
  return { nodeId: drag.sourceNodeId, origin: drag.ghostOrigin ?? null }
}

function isNodeDrag(): boolean {
  const drag = canvasDrag().getState()
  return drag.dragging && !!drag.sourceNodeId
}

function buildGroups(
  groups: WorktreeGroup[],
  nodes: Record<string, ViewNode>,
  ghost: { nodeId: string; origin: Point | null } | null,
  focusedWorktreeId: string | null,
): TerritoryGroup[] {
  const out: TerritoryGroup[] = []
  for (const g of groups) {
    const rects = []
    for (const nodeId of g.nodeIds) {
      const n = nodes[nodeId]
      if (!n) continue
      let o = n.origin
      if (ghost && ghost.nodeId === nodeId) {
        if (!ghost.origin) continue
        o = ghost.origin
      }
      rects.push({ x: o.x, y: o.y, w: n.size.width, h: n.size.height })
    }
    // Focus lens: other worktrees dim like their panels (0.5 opacity).
    const dim = focusedWorktreeId && g.worktreeId !== focusedWorktreeId ? 0.5 : 1
    if (rects.length > 0) out.push({ color: g.color, rects, dim })
  }
  return out
}

function subscribeDrag(listener: () => void): () => void {
  let stopPort = canvasDrag().subscribe(listener)
  const stopInstall = subscribeCanvasDragPort(() => {
    stopPort()
    stopPort = canvasDrag().subscribe(listener)
    listener()
  })
  return () => { stopInstall(); stopPort() }
}

function WorktreeTerritoryLayerImpl({ workspaceId, containerWidth, containerHeight }: Props) {
  const canvasApi = useCanvasViewStore()
  const { groups } = useWorktreeMembership(workspaceId)

  const glCanvasRef = useRef<HTMLCanvasElement>(null)
  const cpuCanvasRef = useRef<HTMLCanvasElement>(null)
  // A new <canvas> (via key) is the reliable way back to a usable context
  // after a loss; re-acquiring on the same element often returns a dead one.
  const [glEpoch, setGlEpoch] = useState(0)
  const glRecoveriesRef = useRef(0)
  const groupsRef = useRef<WorktreeGroup[]>(groups)
  groupsRef.current = groups
  // Read through a ref so a resize never tears down the GL context.
  const sizeRef = useRef({ w: containerWidth, h: containerHeight })
  sizeRef.current = { w: containerWidth, h: containerHeight }

  const dirtyRef = useRef(true)
  const rafRef = useRef(0)
  const ensureRef = useRef<() => void>(() => {})

  const glRef = useRef<TerritoryGL | null>(null)
  const backendRef = useRef<Backend>('gl')
  const lastSigRef = useRef(-1)
  const lastMaskSigRef = useRef(-1)

  // Size the active backend's canvas. The inactive one stays tiny and hidden.
  const sizeActive = () => {
    const { w, h } = sizeRef.current
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const dw = Math.max(1, Math.round(w * dpr))
    const dh = Math.max(1, Math.round(h * dpr))
    const c = backendRef.current === 'gl' ? glCanvasRef.current : cpuCanvasRef.current
    if (!c) return
    // Assigning an unchanged dimension still resets the backing store.
    if (c.width !== dw) c.width = dw
    if (c.height !== dh) c.height = dh
    c.style.width = w + 'px'
    c.style.height = h + 'px'
    if (backendRef.current === 'gl') glRef.current?.resize(dw, dh)
    else c.getContext('2d')?.setTransform(dpr, 0, 0, dpr, 0, 0)
  }

  const applyVisibility = () => {
    const gl = backendRef.current === 'gl'
    if (glCanvasRef.current) glCanvasRef.current.style.display = gl ? 'block' : 'none'
    if (cpuCanvasRef.current) cpuCanvasRef.current.style.display = gl ? 'none' : 'block'
  }

  useEffect(() => {
    sizeActive()
    dirtyRef.current = true
    ensureRef.current()
  }, [containerWidth, containerHeight])

  // Moving between displays changes DPR without a CSS resize; re-arm the
  // query so later moves are seen too.
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    let query: MediaQueryList
    const onChange = () => {
      sizeActive()
      dirtyRef.current = true
      ensureRef.current()
      arm()
    }
    const arm = () => {
      query?.removeEventListener('change', onChange)
      query = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
      query.addEventListener('change', onChange)
    }
    arm()
    return () => query.removeEventListener('change', onChange)
  }, [])

  useEffect(() => {
    const abort = new AbortController()
    const forced = forcedBackend()

    const initGL = () => {
      const canvas = glCanvasRef.current
      if (!canvas) return false
      const glr = createTerritoryGL(canvas)
      if (!glr) return false
      glRef.current = glr
      backendRef.current = 'gl'
      lastSigRef.current = -1
      lastMaskSigRef.current = -1
      sizeActive()
      return true
    }

    const fallbackToCPU = () => {
      if (glRef.current) { glRef.current.dispose(); glRef.current = null }
      backendRef.current = 'cpu'
      applyVisibility()
      sizeActive()
      dirtyRef.current = true
      ensureRef.current()
    }

    if (forced === 'cpu' || !initGL()) backendRef.current = 'cpu'
    applyVisibility()
    sizeActive()

    // On context loss draw on the CPU at once, then try a fresh canvas
    // (bounded). A browser-driven restore on the same canvas is honoured too.
    const glCanvas = glCanvasRef.current
    if (glCanvas) {
      glCanvas.addEventListener('webglcontextlost', (e) => {
        e.preventDefault()
        fallbackToCPU()
        if (forcedBackend() !== 'cpu' && glRecoveriesRef.current < GL_MAX_RECOVERIES) {
          glRecoveriesRef.current += 1
          setGlEpoch((n) => n + 1)
        }
      }, { signal: abort.signal })
      glCanvas.addEventListener('webglcontextrestored', () => {
        if (forcedBackend() === 'cpu') return
        if (initGL()) {
          glRecoveriesRef.current = 0
          applyVisibility(); dirtyRef.current = true; ensureRef.current()
        }
      }, { signal: abort.signal })
    }

    const paintGL = () => {
      const glr = glRef.current
      const canvas = glCanvasRef.current
      if (!glr || !canvas) return
      const cs = canvasApi.getState()
      const zoom = cs.zoomLevel, offX = cs.viewportOffset.x, offY = cs.viewportOffset.y
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const tGroups = buildGroups(groupsRef.current, cs.nodes, dragGhost(), useCanvasUi.getState().focusedWorktreeId)
      const dragging = isNodeDrag()

      const sig = contentSig(tGroups)
      if (sig !== lastSigRef.current) {
        glr.uploadGeometry(buildPrimitives(tGroups))
        lastSigRef.current = sig
        // The mask is non-local; skip it mid-drag and refresh once settled.
        if (ENABLE_POCKET_FILL && !dragging) { glr.uploadMask(buildPocketMask(tGroups)); lastMaskSigRef.current = sig }
      } else if (ENABLE_POCKET_FILL && !dragging && lastMaskSigRef.current !== sig) {
        glr.uploadMask(buildPocketMask(tGroups)); lastMaskSigRef.current = sig
      }
      glr.setView(zoom, offX, offY, dpr)
      glr.draw()
    }

    const paintCPU = () => {
      const canvas = cpuCanvasRef.current
      const ctx = canvas?.getContext('2d')
      if (!canvas || !ctx) return
      const cs = canvasApi.getState()
      const zoom = cs.zoomLevel, offX = cs.viewportOffset.x, offY = cs.viewportOffset.y
      const tGroups = buildGroups(groupsRef.current, cs.nodes, dragGhost(), useCanvasUi.getState().focusedWorktreeId)
      const { w, h } = sizeRef.current
      drawTerritory(
        ctx,
        { width: w, height: h, zoom, offsetX: offX, offsetY: offY },
        tGroups,
        isNodeDrag() ? CPU_GESTURE_CELL_SCALE : 1,
      )
    }

    const frame = () => {
      rafRef.current = 0
      const dragging = isNodeDrag()
      if (dirtyRef.current || dragging) {
        if (backendRef.current === 'gl') paintGL(); else paintCPU()
        dirtyRef.current = false
      }
      if (dragging) rafRef.current = requestAnimationFrame(frame) // follow the ghost
    }
    const ensure = () => { if (!rafRef.current) rafRef.current = requestAnimationFrame(frame) }
    ensureRef.current = ensure

    // Store notifications can outpace compositing; drawing synchronously would
    // queue redundant full-screen GPU work, so coalesce into the next frame.
    const onChange = () => {
      dirtyRef.current = true
      ensure()
    }
    const unsubCanvas = canvasApi.subscribe(onChange)
    const unsubDrag = subscribeDrag(onChange)
    const unsubUI = useCanvasUi.subscribe(onChange)
    ensure()
    return () => {
      abort.abort()
      unsubCanvas()
      unsubDrag()
      unsubUI()
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      rafRef.current = 0
      if (glRef.current) { glRef.current.dispose(); glRef.current = null }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvasApi, glEpoch])

  useEffect(() => { dirtyRef.current = true; ensureRef.current() }, [groups])

  const style: React.CSSProperties = { position: 'absolute', left: 0, top: 0, pointerEvents: 'none', zIndex: 0 }
  return (
    <>
      <canvas key={glEpoch} ref={glCanvasRef} aria-hidden data-worktree-territory style={style} />
      <canvas ref={cpuCanvasRef} aria-hidden data-worktree-territory-cpu style={{ ...style, display: 'none' }} />
    </>
  )
}

export const WorktreeTerritoryLayer = React.memo(WorktreeTerritoryLayerImpl)
