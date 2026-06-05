// =============================================================================
// WorktreeHullLayer — the worktree "sludge": a soft, blurred colored field
// painted behind the panels of each worktree. Lives inside the canvas world div
// (canvas-space), so it pans/zooms with everything for free.
//
// Each tagged node contributes one inflated <rect>; a per-color SVG goo filter
// (blur → alpha threshold → soften) merges same-worktree blobs into one fluid
// shape when near, stretches them when dragged apart, and splits them when far —
// no connection geometry is ever computed. A spring rAF eases each rect toward
// its panel imperatively (no per-frame React), giving the field its alive,
// bouncy motion during drag/resize. React only re-renders when the SET of blobs
// or the hover/focus state changes.
// =============================================================================

import React, { useEffect, useRef } from 'react'
import { useCanvasStoreApi } from '../../stores/CanvasStoreContext'
import { useUIStore } from '../../stores/uiStore'
import { useWorktreeMembership } from './useWorktreeMembership'
import {
  GOO_FILTER_ID,
  BLOB_MARGIN,
  BLOB_RADIUS,
  OPACITY_BASE,
  OPACITY_ACTIVE,
  OPACITY_DIMMED,
  advanceBlob,
  type BlobSpring,
} from './goo'

export const WorktreeHullLayer: React.FC = () => {
  const { groups } = useWorktreeMembership()
  const canvasApi = useCanvasStoreApi()
  const hoveredId = useUIStore((s) => s.hoveredWorktreeId)
  const focusedId = useUIStore((s) => s.focusedWorktreeId)

  const rectRefs = useRef(new Map<string, SVGRectElement>())
  const springs = useRef(new Map<string, BlobSpring>())
  const refCbs = useRef(new Map<string, (el: SVGRectElement | null) => void>())
  const rafRef = useRef(0)
  const runningRef = useRef(false)
  const ensureRunningRef = useRef<() => void>(() => {})

  // --- Spring loop: imperatively chase live node geometry --------------------
  useEffect(() => {
    const tick = () => {
      rafRef.current = 0
      const nodes = canvasApi.getState().nodes
      let anyMoving = false
      springs.current.forEach((s, nodeId) => {
        const node = nodes[nodeId]
        const rect = rectRefs.current.get(nodeId)
        if (!node || !rect) return
        const moving = advanceBlob(
          s,
          node.origin.x - BLOB_MARGIN,
          node.origin.y - BLOB_MARGIN,
          node.size.width + BLOB_MARGIN * 2,
          node.size.height + BLOB_MARGIN * 2,
        )
        rect.setAttribute('x', String(s.x))
        rect.setAttribute('y', String(s.y))
        rect.setAttribute('width', String(Math.max(0, s.w)))
        rect.setAttribute('height', String(Math.max(0, s.h)))
        if (moving) anyMoving = true
      })
      if (anyMoving) rafRef.current = requestAnimationFrame(tick)
      else runningRef.current = false
    }
    const ensureRunning = () => {
      if (runningRef.current) return
      runningRef.current = true
      rafRef.current = requestAnimationFrame(tick)
    }
    ensureRunningRef.current = ensureRunning
    ensureRunning()

    // Any canvas store change (node drag/resize, zoom, add/remove) wakes the
    // loop so the field keeps chasing. Cheap: no-ops while already running.
    const unsubscribe = canvasApi.subscribe(() => ensureRunning())
    return () => {
      unsubscribe()
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      runningRef.current = false
    }
  }, [canvasApi])

  // Wake the loop when the blob set changes (new/removed/recolored panels).
  useEffect(() => {
    ensureRunningRef.current()
  }, [groups])

  // Focus lens: frame the camera onto the focused worktree's nodes on entry.
  const prevFocused = useRef<string | null>(null)
  useEffect(() => {
    if (focusedId && focusedId !== prevFocused.current) {
      const g = groups.find((x) => x.worktreeId === focusedId)
      if (g && g.nodeIds.length > 0) canvasApi.getState().frameNodes(g.nodeIds)
    }
    prevFocused.current = focusedId
  }, [focusedId, groups, canvasApi])

  if (groups.length === 0) return null

  const groupOpacity = (worktreeId: string): number => {
    if (focusedId) return worktreeId === focusedId ? OPACITY_ACTIVE : OPACITY_DIMMED
    if (hoveredId && worktreeId === hoveredId) return OPACITY_ACTIVE
    return OPACITY_BASE
  }

  // Stable per-node ref callbacks (cached so re-renders don't detach the rect
  // and reset its spring). Initializes the spring in-place on first mount.
  const getRefCb = (nodeId: string) => {
    let cb = refCbs.current.get(nodeId)
    if (!cb) {
      cb = (el: SVGRectElement | null) => {
        if (el) {
          rectRefs.current.set(nodeId, el)
          if (!springs.current.has(nodeId)) {
            const node = canvasApi.getState().nodes[nodeId]
            const init: BlobSpring = node
              ? {
                  x: node.origin.x - BLOB_MARGIN,
                  y: node.origin.y - BLOB_MARGIN,
                  w: node.size.width + BLOB_MARGIN * 2,
                  h: node.size.height + BLOB_MARGIN * 2,
                  vx: 0, vy: 0, vw: 0, vh: 0,
                }
              : { x: 0, y: 0, w: 0, h: 0, vx: 0, vy: 0, vw: 0, vh: 0 }
            springs.current.set(nodeId, init)
            el.setAttribute('x', String(init.x))
            el.setAttribute('y', String(init.y))
            el.setAttribute('width', String(Math.max(0, init.w)))
            el.setAttribute('height', String(Math.max(0, init.h)))
          }
          ensureRunningRef.current()
        } else {
          rectRefs.current.delete(nodeId)
          springs.current.delete(nodeId)
          refCbs.current.delete(nodeId)
        }
      }
      refCbs.current.set(nodeId, cb)
    }
    return cb
  }

  return (
    <svg
      aria-hidden
      data-worktree-hull
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        width: 1,
        height: 1,
        overflow: 'visible',
        pointerEvents: 'none',
        zIndex: 0,
      }}
    >
      <defs>
        {/* Alpha-channel metaball threshold: blur spreads each blob, the matrix
            steepens alpha so overlapping blobs fuse into one shape, then a small
            blur softens the merged edge back to a wash. */}
        <filter
          id={GOO_FILTER_ID}
          x="-30%"
          y="-30%"
          width="160%"
          height="160%"
          colorInterpolationFilters="sRGB"
        >
          <feGaussianBlur in="SourceGraphic" stdDeviation="34" result="blur" />
          <feColorMatrix
            in="blur"
            type="matrix"
            values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 26 -11"
            result="goo"
          />
          <feGaussianBlur in="goo" stdDeviation="10" />
        </filter>
      </defs>
      {groups.map((g) => (
        <g
          key={g.worktreeId}
          filter={`url(#${GOO_FILTER_ID})`}
          style={{ opacity: groupOpacity(g.worktreeId), transition: 'opacity 300ms ease' }}
        >
          {g.nodeIds.map((nodeId) => (
            // x/y/width/height are owned imperatively by the spring loop — kept
            // out of JSX so React never resets them.
            <rect key={nodeId} ref={getRefCb(nodeId)} rx={BLOB_RADIUS} ry={BLOB_RADIUS} fill={g.color} />
          ))}
        </g>
      ))}
    </svg>
  )
}

export default WorktreeHullLayer
