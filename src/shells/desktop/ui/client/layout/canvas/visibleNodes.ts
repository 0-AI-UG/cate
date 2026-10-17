// Viewport culling: only nodes near the visible area mount, so off-screen
// terminals and editors hold no live xterm or Monaco. Focused, pinned and
// keep-mounted nodes (native surfaces, whose guest would reload) are exempt.

import { useEffect, useState } from 'react'
import { dockPanels, type NodeId, type PanelId } from '@workspace/document/contract'
import type { CanvasView, CanvasViewStore, ViewNode } from './store'
import { canvasPerfCount } from './perf'
import { focusedNodeId } from './selection'
import { shallowArrayEqual } from './context'

// Creation-ordered node list, cached by `nodes` identity. The cull runs on
// every pan and zoom frame where `nodes` is unchanged. DOM order stays
// creation order: moving a mounted webview in the DOM reloads its guest, so
// stacking is CSS z-index only.
const sortedCache = new WeakMap<object, ViewNode[]>()
function sortedByCreation(nodes: Record<NodeId, ViewNode>): ViewNode[] {
  const cached = sortedCache.get(nodes)
  if (cached) return cached
  canvasPerfCount('canvasCullSort')
  const sorted = Object.values(nodes).sort((a, b) => a.creationIndex - b.creationIndex || a.id.localeCompare(b.id))
  sortedCache.set(nodes, sorted)
  return sorted
}

// The keep-alive node set is keyed by the identity of the keep-mounted panel
// set (stable across frames) and revalidated by a signature over each node's
// dock identity. A geometry drag replaces `nodes` but keeps every dock, so the
// walk is skipped; a tab moving between nodes changes a dock and redoes it.
const EMPTY: ReadonlySet<NodeId> = new Set()
const keepAliveCache = new WeakMap<object, { nodes: object; sig: string; ids: ReadonlySet<NodeId> }>()
let dockTagCounter = 0
const dockTags = new WeakMap<object, number>()

function membershipSignature(nodes: Record<NodeId, ViewNode>): string {
  let sig = ''
  for (const n of Object.values(nodes)) {
    let tag = dockTags.get(n.dock)
    if (tag === undefined) {
      tag = ++dockTagCounter
      dockTags.set(n.dock, tag)
    }
    sig += `${n.id}=d${tag};`
  }
  return sig
}

function keepAliveNodeIds(nodes: Record<NodeId, ViewNode>, keepMounted: ReadonlySet<PanelId> | undefined): ReadonlySet<NodeId> {
  if (!keepMounted || keepMounted.size === 0) return EMPTY
  const cached = keepAliveCache.get(keepMounted)
  if (cached && cached.nodes === nodes) return cached.ids
  const sig = membershipSignature(nodes)
  if (cached && cached.sig === sig) {
    keepAliveCache.set(keepMounted, { nodes, sig, ids: cached.ids })
    return cached.ids
  }
  const ids = new Set<NodeId>()
  for (const n of Object.values(nodes)) {
    if (dockPanels(n.dock).some((id) => keepMounted.has(id))) ids.add(n.id)
  }
  keepAliveCache.set(keepMounted, { nodes, sig, ids })
  return ids
}

/** Creation-ordered ids of the nodes to mount: those within a screen's
 *  margin of the viewport, plus the exempt ones. */
function selectVisibleNodeIds(
  s: Pick<CanvasView, 'nodes' | 'viewportOffset' | 'zoomLevel' | 'containerSize' | 'selection' | 'selectionActive'>,
  keepMounted?: ReadonlySet<PanelId>,
): NodeId[] {
  canvasPerfCount('canvasCullEval')
  const { nodes, viewportOffset, zoomLevel: z, containerSize } = s
  const focused = focusedNodeId(s)
  const cw = containerSize.width
  const ch = containerSize.height
  const sorted = sortedByCreation(nodes)
  // Before the container is measured, mount everything so nothing flashes.
  if (cw === 0 || ch === 0 || z <= 0) return sorted.map((n) => n.id)

  const keepAlive = keepAliveNodeIds(nodes, keepMounted)
  const marginX = cw / z
  const marginY = ch / z
  const left = -viewportOffset.x / z - marginX
  const top = -viewportOffset.y / z - marginY
  const right = (cw - viewportOffset.x) / z + marginX
  const bottom = (ch - viewportOffset.y) / z + marginY

  const result: NodeId[] = []
  for (const n of sorted) {
    if (n.id === focused || n.isPinned || keepAlive.has(n.id)) {
      result.push(n.id)
      continue
    }
    const nr = n.origin.x + n.size.width
    const nb = n.origin.y + n.size.height
    if (nr < left || n.origin.x > right || nb < top || n.origin.y > bottom) continue
    result.push(n.id)
  }
  return result
}

export function useVisibleNodeIds(store: CanvasViewStore, keepMounted: ReadonlySet<PanelId>): NodeId[] {
  const [visible, setVisible] = useState(() => selectVisibleNodeIds(store.getState(), keepMounted))

  useEffect(() => {
    let settleTimer: ReturnType<typeof setTimeout> | undefined
    const publish = (ids: NodeId[]) => setVisible((current) => (shallowArrayEqual(current, ids) ? current : ids))
    const cancelPending = () => {
      if (settleTimer) clearTimeout(settleTimer)
      settleTimer = undefined
    }
    // A smooth zoom updates every frame; publishing each intermediate cull
    // would mount and unmount Monaco and xterm mid-gesture. Hold the mounted
    // set while zooming and reconcile once it settles. Pans and structural
    // changes publish at once.
    const unsubscribe = store.subscribe((state, previous) => {
      const structural = state.nodes !== previous.nodes
        || state.containerSize !== previous.containerSize
        || state.selection !== previous.selection
        || state.selectionActive !== previous.selectionActive
      if (state.zoomLevel !== previous.zoomLevel && !structural) {
        cancelPending()
        settleTimer = setTimeout(() => {
          settleTimer = undefined
          publish(selectVisibleNodeIds(store.getState(), keepMounted))
        }, 120)
        return
      }
      if (state.viewportOffset === previous.viewportOffset && !structural) return
      cancelPending()
      publish(selectVisibleNodeIds(state, keepMounted))
    })
    publish(selectVisibleNodeIds(store.getState(), keepMounted))
    return () => {
      cancelPending()
      unsubscribe()
    }
  }, [store, keepMounted])

  return visible
}

const NODE_MOUNT_BATCH = 6

/** Spreads a large cold mount across frames: ids already mounted stay, new
 *  ones join a few per frame. */
export function useStagedVisibleNodeIds(visible: NodeId[]): NodeId[] {
  const [limit, setLimit] = useState(NODE_MOUNT_BATCH)
  useEffect(() => {
    if (limit >= visible.length) return
    const frame = requestAnimationFrame(() => setLimit((current) => Math.min(current + NODE_MOUNT_BATCH, visible.length)))
    return () => cancelAnimationFrame(frame)
  }, [limit, visible.length])
  return visible.slice(0, limit)
}
