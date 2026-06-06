// =============================================================================
// WorktreeTerritoryLayer — React/canvas glue for the worktree terrace territory.
//
// Thin on purpose: owns the <canvas>es, keeps them sized + DPR-correct, drives a
// dirty-gated rAF, and assembles the renderer's inputs (membership + live node
// geometry + the live drag-ghost position). Rendered in SCREEN space as a sibling
// of CanvasGrid (outside the world transform).
//
// Primary path is the WebGL2 fragment renderer (territoryGL): the territory field
// is a pure function of WORLD position, so pan/zoom/drag are each just a uniform
// update + one full-screen-quad draw — full resolution every frame, no tile cache.
// The CPU `drawTerritory` is kept as a verified fallback (WebGL2 unavailable /
// context lost) and as the A/B reference. Backend is forceable via localStorage
// `cate.territory.backend` = 'gl' | 'cpu'.
// =============================================================================

import React, { useEffect, useRef, useState } from 'react'
import { useCanvasStoreApi } from '../../stores/CanvasStoreContext'
import { useUIStore } from '../../stores/uiStore'
import { useDragStore } from '../../drag'
import { useWorktreeMembership, type WorktreeGroup } from './useWorktreeMembership'
import { drawTerritory, type TerritoryGroup } from './territoryRenderer'
import { createTerritoryGL, buildPrimitives, type TerritoryGL } from './territoryGL'
import { buildPocketMask } from './territoryPocketMask'

interface Props {
  containerWidth: number
  containerHeight: number
}

type Backend = 'gl' | 'cpu'

/** Coarser field cell for the CPU fallback while a gesture moves (the GL path
 *  needs no such trick — it is full-res every frame). */
const CPU_GESTURE_CELL_SCALE = 2

/** Max times we remount a fresh GL canvas to recover from context loss before
 *  giving up and staying on CPU — so a permanently-gone GPU settles instead of
 *  thrashing lost→remount→lost forever. */
const GL_MAX_RECOVERIES = 3

/** Enclosed-pocket fill (CPU fillEnclosed) is a non-local flood fill that cannot
 *  be reconciled with per-pixel shader rendering: a discrete mask boundary lands
 *  blocky inside a background region, and coarse flood partially seals channels,
 *  so pockets fill partially and bleed past the contour. It only fills rare fully
 *  enclosed "lakes", so the GL path omits it — an enclosed lake reads as a clean
 *  clearing (grid inside a smooth contour) instead of a blocky artifact. */
const ENABLE_POCKET_FILL = false

function forcedBackend(): Backend | null {
  try {
    const v = localStorage.getItem('cate.territory.backend')
    return v === 'cpu' || v === 'gl' ? v : null
  } catch { return null }
}

/** Cheap content signature: changes on panel geometry / colour / membership, but
 *  NOT on pan/zoom. Gates geometry + pocket-mask re-upload to the GPU. */
function contentSig(groups: TerritoryGroup[]): number {
  let h = 2166136261 >>> 0
  for (const g of groups) {
    for (let i = 0; i < g.color.length; i++) h = Math.imul(h ^ g.color.charCodeAt(i), 16777619)
    h = Math.imul(h ^ Math.round((g.dim ?? 1) * 100), 16777619) // lens dim → re-upload
    for (const rc of g.rects) {
      h = Math.imul(h ^ (rc.x | 0), 16777619)
      h = Math.imul(h ^ (rc.y | 0), 16777619)
      h = Math.imul(h ^ (rc.w | 0), 16777619)
      h = Math.imul(h ^ (rc.h | 0), 16777619)
    }
  }
  return h >>> 0
}

/** Live canvas-space origin of the node being whole-node dragged (its store
 *  origin is frozen until drop), so its territory follows the ghost in real time. */
function dragGhostOrigin(
  canvas: HTMLCanvasElement,
  zoom: number,
  offX: number,
  offY: number,
): { nodeId: string; x: number; y: number } | null {
  const drag = useDragStore.getState()
  if (drag.source?.origin.kind !== 'canvas-node') return null
  if (!drag.cursor?.insideWindow || !drag.grab) return null
  const r = canvas.getBoundingClientRect()
  const wx = (drag.cursor.client.x - r.left - offX) / zoom
  const wy = (drag.cursor.client.y - r.top - offY) / zoom
  return { nodeId: drag.source.origin.nodeId, x: wx - drag.grab.x, y: wy - drag.grab.y }
}

function buildGroups(
  groups: WorktreeGroup[],
  nodes: ReturnType<ReturnType<typeof useCanvasStoreApi>['getState']>['nodes'],
  ghost: { nodeId: string; x: number; y: number } | null,
  focusedWorktreeId: string | null,
): TerritoryGroup[] {
  const out: TerritoryGroup[] = []
  for (const g of groups) {
    const rects = []
    for (const nodeId of g.nodeIds) {
      const n = nodes[nodeId]
      if (!n) continue
      const o = ghost && ghost.nodeId === nodeId ? ghost : n.origin
      rects.push({ x: o.x, y: o.y, w: n.size.width, h: n.size.height })
    }
    // Focus lens: non-focused worktrees dim to match the panels (0.5 opacity).
    const dim = focusedWorktreeId && g.worktreeId !== focusedWorktreeId ? 0.5 : 1
    if (rects.length > 0) out.push({ color: g.color, rects, dim })
  }
  return out
}

const WorktreeTerritoryLayer: React.FC<Props> = ({ containerWidth, containerHeight }) => {
  const canvasApi = useCanvasStoreApi()
  const { groups } = useWorktreeMembership()

  const glCanvasRef = useRef<HTMLCanvasElement>(null)
  const cpuCanvasRef = useRef<HTMLCanvasElement>(null)
  // Bumping glEpoch swaps in a brand-new <canvas> element (via React key) to
  // recover a usable GL context after a loss — re-acquiring on the same canvas
  // is unreliable. glRecoveriesRef bounds how many times we'll try.
  const [glEpoch, setGlEpoch] = useState(0)
  const glRecoveriesRef = useRef(0)
  const groupsRef = useRef<WorktreeGroup[]>(groups)
  groupsRef.current = groups
  // Live container size, read from refs so the renderer effect needn't depend on
  // it (a resize must not tear down + recreate the WebGL context).
  const sizeRef = useRef({ w: containerWidth, h: containerHeight })
  sizeRef.current = { w: containerWidth, h: containerHeight }

  const dirtyRef = useRef(true)
  const rafRef = useRef(0)
  const ensureRef = useRef<() => void>(() => {})

  const glRef = useRef<TerritoryGL | null>(null)
  const backendRef = useRef<Backend>('gl')
  const lastSigRef = useRef(-1)        // last geometry signature uploaded to the GPU
  const lastMaskSigRef = useRef(-1)    // last signature the pocket mask was built for

  // Size the active backend's canvas (DPR-aware). The inactive canvas is left
  // tiny + hidden so it costs no backing-store memory.
  const sizeActive = () => {
    const { w, h } = sizeRef.current
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const dw = Math.max(1, Math.round(w * dpr))
    const dh = Math.max(1, Math.round(h * dpr))
    if (backendRef.current === 'gl') {
      const c = glCanvasRef.current
      if (c) {
        c.width = dw; c.height = dh
        c.style.width = w + 'px'; c.style.height = h + 'px'
        glRef.current?.resize(dw, dh)
      }
    } else {
      const c = cpuCanvasRef.current
      if (c) {
        c.width = dw; c.height = dh
        c.style.width = w + 'px'; c.style.height = h + 'px'
        c.getContext('2d')?.setTransform(dpr, 0, 0, dpr, 0, 0)
      }
    }
  }

  const applyVisibility = () => {
    const gl = backendRef.current === 'gl'
    if (glCanvasRef.current) glCanvasRef.current.style.display = gl ? 'block' : 'none'
    if (cpuCanvasRef.current) cpuCanvasRef.current.style.display = gl ? 'none' : 'block'
  }

  // Re-size whenever the container changes.
  useEffect(() => {
    sizeActive()
    dirtyRef.current = true
    ensureRef.current()
  }, [containerWidth, containerHeight])

  // Renderer setup + dirty-driven rAF.
  useEffect(() => {
    const abort = new AbortController()
    const forced = forcedBackend()

    // --- WebGL path ----------------------------------------------------------
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

    if (forced === 'cpu') {
      backendRef.current = 'cpu'
    } else if (!initGL()) {
      backendRef.current = 'cpu'
    }
    applyVisibility()
    sizeActive()

    // Context-loss handling: drop GL and fall back to CPU immediately so the
    // territory keeps rendering. Then try to get back onto the GPU by remounting
    // a fresh <canvas> (bumping glEpoch) — a new element yields a new context,
    // whereas re-acquiring webgl2 on the just-lost canvas often keeps returning
    // a dead one. Bounded by GL_MAX_RECOVERIES so a permanently-lost GPU stays
    // on CPU instead of looping. A browser-driven restore on the same canvas
    // (webglcontextrestored) is also honored as a fast path and resets the count.
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
      const ghost = dragGhostOrigin(canvas, zoom, offX, offY)
      const focused = useUIStore.getState().focusedWorktreeId
      const tGroups = buildGroups(groupsRef.current, cs.nodes, ghost, focused)
      const dragging = useDragStore.getState().source?.origin.kind === 'canvas-node'

      const sig = contentSig(tGroups)
      if (sig !== lastSigRef.current) {
        glr.uploadGeometry(buildPrimitives(tGroups))
        lastSigRef.current = sig
        // Pocket mask is non-local + recompute-on-change: skip mid-drag (the
        // ghost moves every frame), refresh once the geometry settles.
        if (ENABLE_POCKET_FILL && !dragging) { glr.uploadMask(buildPocketMask(tGroups)); lastMaskSigRef.current = sig }
      } else if (ENABLE_POCKET_FILL && !dragging && lastMaskSigRef.current !== sig) {
        glr.uploadMask(buildPocketMask(tGroups)); lastMaskSigRef.current = sig
      }
      glr.setView(zoom, offX, offY, dpr)
      glr.draw()
    }

    // --- CPU fallback path (full-res direct draw; coarse during a gesture) ----
    const paintCPU = () => {
      const canvas = cpuCanvasRef.current
      const ctx = canvas?.getContext('2d')
      if (!canvas || !ctx) return
      const cs = canvasApi.getState()
      const zoom = cs.zoomLevel, offX = cs.viewportOffset.x, offY = cs.viewportOffset.y
      const ghost = dragGhostOrigin(canvas, zoom, offX, offY)
      const focused = useUIStore.getState().focusedWorktreeId
      const tGroups = buildGroups(groupsRef.current, cs.nodes, ghost, focused)
      const dragging = useDragStore.getState().source?.origin.kind === 'canvas-node'
      const { w, h } = sizeRef.current
      drawTerritory(
        ctx,
        { width: w, height: h, zoom, offsetX: offX, offsetY: offY },
        tGroups,
        dragging ? CPU_GESTURE_CELL_SCALE : 1,
      )
    }

    const frame = () => {
      rafRef.current = 0
      const dragging = useDragStore.getState().source?.origin.kind === 'canvas-node'
      if (dirtyRef.current || dragging) {
        if (backendRef.current === 'gl') paintGL(); else paintCPU()
        dirtyRef.current = false
      }
      if (dragging) rafRef.current = requestAnimationFrame(frame) // follow the ghost
    }
    const ensure = () => { if (!rafRef.current) rafRef.current = requestAnimationFrame(frame) }
    ensureRef.current = ensure

    const onChange = () => { dirtyRef.current = true; ensure() }
    const unsubCanvas = canvasApi.subscribe(onChange) // zoom / pan / nodes / worktree map
    const unsubDrag = useDragStore.subscribe(onChange)
    const unsubUI = useUIStore.subscribe(onChange) // focus-lens dim
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

  // Membership changes (React state) → repaint.
  useEffect(() => { dirtyRef.current = true; ensureRef.current() }, [groups])

  const style: React.CSSProperties = { position: 'absolute', left: 0, top: 0, pointerEvents: 'none', zIndex: 0 }
  return (
    <>
      <canvas key={glEpoch} ref={glCanvasRef} aria-hidden data-worktree-territory style={style} />
      <canvas ref={cpuCanvasRef} aria-hidden data-worktree-territory-cpu style={{ ...style, display: 'none' }} />
    </>
  )
}

export default React.memo(WorktreeTerritoryLayer)
