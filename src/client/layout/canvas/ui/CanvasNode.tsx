// A floating node on the canvas: its frame (border, focus glow, resize
// band, lock and close) around the node's mini dock, which the dock
// layer renders. Moving the whole node or detaching a tab goes through the
// drag layer.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Lock, LockOpen, X } from 'lucide-react'
import { Tooltip, getActiveTheme, subscribeTheme } from '@kernel/ui'
import { clientStateFor, documentStoreFor } from '@client/document'
import { useClientState, useDocument } from '@client/document/ui'
import { dockPanels, placementOf, stackOfPanel, findStack, type NodeId, type PanelId } from '@workspace/document/contract'
import { worktreeForPanel } from '@workspace/repository/contract'
import { PanelRelationHandle, connectPanelToExisting } from '@workspace/relations/ui'
import { canvasDrag, canvasHost, panelMinimumSize } from '../ports'
import { useWorkspaceSetting } from '../settings'
import { activeNodePanelId, type ViewNode } from '../store'
import { isGroupDragMember, isSelected as isNodeSelected } from '../selection'
import { checkoutHooks } from '../actions'
import { useCanvasTopOverlayTarget, useCanvasView, useCanvasViewStore } from './context'
import { useIsDragging, useIsDragSource } from './dragState'
import { isFileDrag } from '@client/layout/drag'
import { useCanvasNodeStyle } from './useCanvasNodeStyle'
import { useNodeResize } from './useNodeResize'
import { NodeResizeOverlay } from './NodeResizeOverlay'
import { canvasSlots } from './slots'
import { useCanvasUi } from './uiState'
import { showContextMenu } from './contextMenu'
import { worktreeColor as paletteColor } from './worktree'
import type { ResizeEdge } from '../parts/resizeEdge'

const GRAB_STRIP_HEIGHT = 22
const TAB_ICON_SIZE = 12

const NODE_STYLES_MARKER = '/* cate-canvas-node */'
const NODE_STYLES = `${NODE_STYLES_MARKER}
/* The tab bar's bottom border matches the active tab so it reads as one surface. */
[data-node-id] .dock-tab-bar { border-bottom-color: var(--surface-3) !important; }
/* Tab bar actions are noise on an unfocused node. */
[data-node-id][data-node-active="false"] .dock-tab-bar button,
[data-node-id][data-node-active="false"] .dock-tab-bar .group > span:last-child {
  opacity: 0 !important;
  pointer-events: none !important;
}
`

let stylesInjected = false
function ensureStyles(): void {
  if (stylesInjected || typeof document === 'undefined') return
  // Replace an earlier module's copy on hot reload instead of stacking them.
  for (const previous of document.head.querySelectorAll('style')) {
    if (previous.textContent?.includes(NODE_STYLES_MARKER)) previous.remove()
  }
  const style = document.createElement('style')
  style.textContent = NODE_STYLES
  document.head.appendChild(style)
  stylesInjected = true
}

// Under the hand tool a left press pans, so node handlers let it bubble.
function handToolPanShouldWin(e: React.MouseEvent): boolean {
  return e.button === 0 && useCanvasUi.getState().activeTool === 'hand'
}

function GrabButton({ title, onClick, color, children }: {
  title: string
  onClick: (e: React.MouseEvent) => void
  color?: string
  children: React.ReactNode
}): React.ReactElement {
  return (
    <Tooltip label={title} action={title === 'Close' ? 'closePanel' : undefined}>
      <button
        data-grab-button
        aria-label={title}
        onClick={onClick}
        className="flex items-center justify-center self-center rounded-[10px] text-muted hover:text-primary hover:bg-hover w-[22px] h-[22px]"
        style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: color ?? 'var(--text-secondary)' }}
      >
        {children}
      </button>
    </Tooltip>
  )
}

function sameNodeView(a: ViewNode | undefined, b: ViewNode | undefined): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return a.origin.x === b.origin.x && a.origin.y === b.origin.y
    && a.size.width === b.size.width && a.size.height === b.size.height
    && a.zOrder === b.zOrder && a.isPinned === b.isPinned
    && a.animationState === b.animationState && a.dock === b.dock
}

interface CanvasNodeProps {
  workspaceId: string
  canvasId: string
  canvasPanelId: string
  nodeId: NodeId
  isFocused: boolean
}

function CanvasNode({ workspaceId, canvasId, canvasPanelId, nodeId, isFocused }: CanvasNodeProps): React.ReactElement | null {
  ensureStyles()
  const store = useCanvasViewStore()
  const topOverlayTarget = useCanvasTopOverlayTarget()
  const nodeRef = useRef<HTMLDivElement>(null)
  const [isHovered, setIsHovered] = useState(false)
  const node = useCanvasView((s) => s.nodes[nodeId], sameNodeView)
  const isSelected = useCanvasView((s) => isNodeSelected(s, nodeId))
  const isDragging = useIsDragging()
  const isWholeNodeDragSource = useIsDragSource(nodeId)
  const { NodeDock } = canvasSlots()

  // A file or panel drag over an unfocused node: the dim overlay lets it
  // through to the panel content that owns the drop.
  const [fileDragOver, setFileDragOver] = useState(false)
  useEffect(() => {
    if (!fileDragOver) return
    const clear = () => setFileDragOver(false)
    // Guest webviews do not bubble drop or leave into this document; restore
    // click-to-focus once the drag leaves this node, ends, or the mouse moves.
    const onDragOver = (e: DragEvent) => {
      const r = nodeRef.current?.getBoundingClientRect()
      if (!r || e.clientX < r.left || e.clientX >= r.right || e.clientY < r.top || e.clientY >= r.bottom) clear()
    }
    window.addEventListener('dragover', onDragOver, true)
    window.addEventListener('drop', clear, true)
    window.addEventListener('dragend', clear, true)
    window.addEventListener('mousemove', clear, true)
    return () => {
      window.removeEventListener('dragover', onDragOver, true)
      window.removeEventListener('drop', clear, true)
      window.removeEventListener('dragend', clear, true)
      window.removeEventListener('mousemove', clear, true)
    }
  }, [fileDragOver])

  // --- The node's visible panel -------------------------------------------------
  const dock = node?.dock ?? null
  // Only this node's active tab: a tab switch elsewhere does not re-render it.
  const activePanelId = useClientState(workspaceId, (s) => (dock ? activeNodePanelId(dock, s.activeTabs) : null))
  const activePanel = useDocument(workspaceId, (d) => (activePanelId ? d.panels[activePanelId] : undefined))
  const relationsEnabled = useWorkspaceSetting(workspaceId, 'panelRelationsEnabled')
  const canConnect = Boolean(relationsEnabled && activePanel)

  // --- Worktree identity follows the visible tab --------------------------------
  // Only with 2+ worktrees, so single-branch work shows no tint.
  const worktreeMap = useDocument(workspaceId, (d) => d.worktrees)
  const readyWorktrees = useMemo(() => Object.values(worktreeMap).filter((w) => w.status === 'ready'), [worktreeMap])
  const [theme, setTheme] = useState(getActiveTheme)
  useEffect(() => subscribeTheme(setTheme), [])
  const activeWorktree = useMemo(() => {
    if (readyWorktrees.length < 2 || !activePanel) return undefined
    const own = worktreeForPanel(activePanel, readyWorktrees, checkoutHooks)
    if (own) return own
    // An untagged checkout-bound panel runs in the main checkout, which
    // every other checkout lives under: the shortest path.
    if (!checkoutHooks.bound?.(activePanel.type)) return undefined
    return [...readyWorktrees].sort((a, b) => a.path.length - b.path.length)[0]
  }, [readyWorktrees, activePanel])
  const activeWorktreeId = activeWorktree?.id ?? null
  const worktreeTint = activeWorktree ? paletteColor(activeWorktree.color, theme) : null
  const hoveredWorktreeId = useCanvasUi((s) => s.hoveredWorktreeId)
  const focusedWorktreeId = useCanvasUi((s) => s.focusedWorktreeId)
  const worktreeHighlight = !!activeWorktreeId && (hoveredWorktreeId === activeWorktreeId || focusedWorktreeId === activeWorktreeId)
  const worktreeDim = !!focusedWorktreeId && activeWorktreeId !== focusedWorktreeId

  // The territory and lens layers read each node's worktree from the store.
  useEffect(() => {
    store.getState().setNodeActiveWorktree(nodeId, activeWorktreeId)
  }, [store, nodeId, activeWorktreeId])
  // Cleared only on unmount, so the territory never flickers.
  useEffect(() => () => store.getState().setNodeActiveWorktree(nodeId, null), [store, nodeId])

  // --- Enter animation ------------------------------------------------------------
  useEffect(() => {
    if (node?.animationState !== 'entering') return
    let inner = 0
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => store.getState().setNodeAnimationState(nodeId, 'idle'))
    })
    return () => {
      cancelAnimationFrame(outer)
      cancelAnimationFrame(inner)
    }
  }, [node?.animationState, nodeId, store])

  // --- Dragging -------------------------------------------------------------------
  const startNodeDrag = useCallback((e: React.MouseEvent) => {
    const state = store.getState()
    const current = state.nodes[nodeId]
    const panelId = current ? activeNodePanelId(current.dock, clientStateFor(workspaceId)?.getSnapshot().activeTabs) : null
    if (!current || current.isPinned || !panelId) return
    // A member of a multi-selection carries the group, so the drag layer
    // moves all of it by the anchor's delta.
    const grouped = isGroupDragMember(state.selection, nodeId)
    const members = grouped
      ? state.selection
        .filter((id) => id !== nodeId)
        .map((id) => state.nodes[id])
        .filter((n): n is ViewNode => !!n && !n.isPinned)
        .map((n) => ({ nodeId: n.id, startOrigin: { x: n.origin.x, y: n.origin.y } }))
      : undefined
    canvasDrag().beginNodeDrag(e.nativeEvent, {
      workspaceId,
      canvasId,
      nodeId,
      panelId,
      ...(grouped ? { startOrigin: { x: current.origin.x, y: current.origin.y }, members } : {}),
    })
  }, [store, nodeId, workspaceId, canvasId])

  // The tab bar: the empty bar moves the node; a tab moves the node when it is
  // the only one, else detaches that tab. In a group, anything moves the group.
  const handleTabBarMouseDown = useCallback((e: React.MouseEvent, panelId?: string) => {
    if (handToolPanShouldWin(e)) return
    const current = store.getState().nodes[nodeId]
    if (!current) return
    if (isGroupDragMember(store.getState().selection, nodeId)) {
      startNodeDrag(e)
      return
    }
    if (panelId && dockPanels(current.dock).length > 1) {
      const stack = stackOfPanel(current.dock, panelId)
      if (stack) {
        canvasDrag().beginTabDrag(e.nativeEvent, { workspaceId, canvasId, nodeId, stackId: stack.id, panelId })
        return
      }
    }
    startNodeDrag(e)
  }, [store, nodeId, startNodeDrag, workspaceId, canvasId])

  // --- Resizing -------------------------------------------------------------------
  const minSizeOf = useCallback((id: NodeId) => {
    const target = store.getState().nodes[id]
    const doc = documentStoreFor(workspaceId)?.getSnapshot()
    const panelId = target ? activeNodePanelId(target.dock, clientStateFor(workspaceId)?.getSnapshot().activeTabs) : null
    return panelMinimumSize(panelId ? doc?.panels[panelId]?.type : undefined)
  }, [store, workspaceId])
  const { handleResizeStart } = useNodeResize(nodeId, store, minSizeOf)
  const handleResizeStartGuarded = useCallback((e: React.MouseEvent, edge: ResizeEdge) => {
    if (handToolPanShouldWin(e)) return
    handleResizeStart(e, edge)
  }, [handleResizeStart])

  // --- Actions --------------------------------------------------------------------
  const handleClose = useCallback(() => {
    const current = store.getState().nodes[nodeId]
    if (current) void canvasHost().closePanels(workspaceId, dockPanels(current.dock))
  }, [store, nodeId, workspaceId])

  const handleTogglePin = useCallback(() => store.getState().togglePin(nodeId), [store, nodeId])

  // Moves the panel out of the node into the dock stack holding this canvas,
  // next to the canvas tab. Shared placement: every client sees the move.
  const moveIntoDock = useCallback((panelId: PanelId) => {
    const documentStore = documentStoreFor(workspaceId)
    const doc = documentStore?.getSnapshot()
    const host = doc ? placementOf(doc, canvasPanelId) : null
    if (!documentStore || !host) return
    const ok = documentStore.propose({ kind: 'placePanel', id: panelId, at: { to: 'stack', dock: host.dock, stackId: host.stackId, after: canvasPanelId } }).ok
    if (!ok) return
    const clientState = clientStateFor(workspaceId)
    clientState?.setActiveTab(host.stackId, panelId)
    clientState?.focus(panelId)
  }, [workspaceId, canvasPanelId])

  // --- Focus ------------------------------------------------------------------------
  // The pane last pressed inside a split node: the first stack's tab is not
  // always what the user is working in.
  const pressedLeafRef = useRef<PanelId | null>(null)

  const preferredLeaf = useCallback((): PanelId | null => {
    const current = store.getState().nodes[nodeId]
    if (!current) return null
    const pressed = pressedLeafRef.current
    if (pressed && dockPanels(current.dock).includes(pressed)) return pressed
    pressedLeafRef.current = null
    return activeNodePanelId(current.dock, clientStateFor(workspaceId)?.getSnapshot().activeTabs)
  }, [store, nodeId, workspaceId])

  const focusThisNode = useCallback(() => {
    store.getState().focusNode(nodeId)
    const leaf = preferredLeaf()
    if (leaf) clientStateFor(workspaceId)?.focus(leaf)
  }, [store, nodeId, preferredLeaf, workspaceId])

  // Every press records the pane it landed in and points focus at it, so
  // moving between panes of a focused node moves the focused panel too.
  const recordPressedLeaf = useCallback((target: EventTarget | null) => {
    const el = target as HTMLElement | null
    const stackId = el?.closest?.<HTMLElement>('[data-dock-stack-id]')?.dataset.dockStackId
    const current = store.getState().nodes[nodeId]
    if (!stackId || !current) return
    const stack = findStack(current.dock, stackId)
    const clicked = el?.closest?.<HTMLElement>('[data-tab-panel-id]')?.dataset.tabPanelId
    const activeTab = stack ? clientStateFor(workspaceId)?.getSnapshot().activeTabs[stack.id] : undefined
    const leaf = clicked ?? (activeTab && stack?.panels.includes(activeTab) ? activeTab : stack?.panels[0])
    if (!leaf) return
    pressedLeafRef.current = leaf
    clientStateFor(workspaceId)?.focus(leaf)
  }, [store, nodeId, workspaceId])

  // While focused, a tab switch or close in the node moves focus to the new
  // visible panel.
  const lastActiveRef = useRef(activePanelId)
  useEffect(() => {
    const changed = lastActiveRef.current !== activePanelId
    lastActiveRef.current = activePanelId
    if (changed) pressedLeafRef.current = null
    if (!isFocused) return
    const leaf = preferredLeaf()
    if (leaf && (changed || clientStateFor(workspaceId)?.getSnapshot().focusedPanelId !== leaf)) {
      clientStateFor(workspaceId)?.focus(leaf)
    }
  }, [isFocused, activePanelId, preferredLeaf, workspaceId])

  const handleClick = useCallback((e: React.MouseEvent) => {
    if (canvasDrag().wasDragged()) return
    if (useCanvasUi.getState().activeTool === 'hand') return
    if (e.shiftKey) {
      store.getState().toggleNodeSelection(nodeId)
      return
    }
    // focusNode collapses the selection to this node and activates it; an
    // active node is already the sole selection.
    if (!isFocused) focusThisNode()
  }, [store, nodeId, isFocused, focusThisNode])

  const handleGrabStripMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0 || handToolPanShouldWin(e)) return
    if ((e.target as HTMLElement).closest('[data-grab-button]')) return
    e.stopPropagation()
    if (e.detail === 2) {
      const leaf = preferredLeaf()
      if (leaf) moveIntoDock(leaf)
      return
    }
    startNodeDrag(e)
  }, [preferredLeaf, moveIntoDock, startNodeDrag])

  const handleGrabStripContextMenu = useCallback(async (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const pinned = store.getState().nodes[nodeId]?.isPinned
    const id = await showContextMenu([
      { id: 'dock', label: 'Move into Dock' },
      { id: 'pin', label: pinned ? 'Unlock' : 'Lock' },
      ...(canConnect ? [{ id: 'connect', label: 'Connect to…' }] : []),
      { type: 'separator' },
      { id: 'front', label: 'Move to Front' },
      { id: 'back', label: 'Move to Back' },
      { type: 'separator' },
      { id: 'close', label: 'Close', accelerator: 'Cmd+W' },
    ])
    switch (id) {
      case 'dock': {
        const leaf = preferredLeaf()
        if (leaf) moveIntoDock(leaf)
        break
      }
      case 'pin': handleTogglePin(); break
      case 'connect': if (activePanelId) void connectPanelToExisting(workspaceId, activePanelId); break
      case 'front': store.getState().moveToFront(nodeId); break
      case 'back': store.getState().moveToBack(nodeId); break
      case 'close': handleClose(); break
    }
  }, [store, nodeId, canConnect, preferredLeaf, moveIntoDock, handleTogglePin, activePanelId, workspaceId, handleClose])

  const { containerStyle, glowStyle } = useCanvasNodeStyle({
    node,
    isFocused,
    isSelected,
    isHovered,
    isWholeNodeDragSource,
    worktreeColor: worktreeTint,
    worktreeHighlight,
    worktreeDim,
  })

  if (!node) return null

  const rootIsStack = node.dock.kind === 'stack'
  const controls = (
    <>
      <GrabButton
        title={node.isPinned ? 'Unlock' : 'Lock'}
        onClick={(e) => { e.stopPropagation(); handleTogglePin() }}
        color={node.isPinned ? 'var(--focus-blue)' : undefined}
      >
        {node.isPinned ? <Lock size={TAB_ICON_SIZE} /> : <LockOpen size={TAB_ICON_SIZE} />}
      </GrabButton>
      <GrabButton title="Close" onClick={(e) => { e.stopPropagation(); handleClose() }}>
        <X size={TAB_ICON_SIZE} />
      </GrabButton>
    </>
  )

  return (
    <>
      {glowStyle && (topOverlayTarget
        ? createPortal(<div aria-hidden data-glow-for={nodeId} style={glowStyle} />, topOverlayTarget)
        : <div aria-hidden data-glow-for={nodeId} style={glowStyle} />)}
      <div
        ref={nodeRef}
        data-node-id={nodeId}
        data-active-panel-id={activePanelId ?? undefined}
        data-node-active={isFocused ? 'true' : 'false'}
        style={containerStyle}
        onClick={handleClick}
        // A right press inside a panel must not start a canvas pan.
        onMouseDown={(e) => { if (e.button === 2) e.stopPropagation() }}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      >
        {/* A split node has no single tab bar to grab, so it gets a strip. */}
        {!rootIsStack && (
          <div
            data-node-grab-strip
            style={{
              height: GRAB_STRIP_HEIGHT,
              display: 'flex',
              alignItems: 'center',
              backgroundColor: 'var(--node-chrome-bg, var(--surface-1))',
              borderBottom: '1px solid var(--border-subtle)',
              flexShrink: 0,
              cursor: 'grab',
            }}
            onMouseDown={handleGrabStripMouseDown}
            onContextMenu={handleGrabStripContextMenu}
          >
            <div style={{ flex: 1, height: '100%' }} />
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 2,
                paddingRight: 4,
                opacity: isFocused ? 1 : 0,
                pointerEvents: isFocused ? undefined : 'none',
                transition: 'opacity 150ms ease',
              }}
              onMouseDown={(e) => e.stopPropagation()}
            >
              {controls}
            </div>
          </div>
        )}

        <div
          data-panel-content
          onDragLeave={(e) => {
            // Entering a webview reports relatedTarget null even inside the panel.
            if (!e.relatedTarget) {
              const r = e.currentTarget.getBoundingClientRect()
              if (e.clientX >= r.left && e.clientX < r.right && e.clientY >= r.top && e.clientY < r.bottom) return
            }
            if (!e.currentTarget.contains(e.relatedTarget as Node)) setFileDragOver(false)
          }}
          onDrop={() => setFileDragOver(false)}
          style={{
            position: 'relative',
            height: rootIsStack ? '100%' : `calc(100% - ${GRAB_STRIP_HEIGHT}px)`,
            overflow: 'hidden',
            // Inside the border, so the radius shrinks by that inset.
            clipPath: rootIsStack
              ? 'inset(0 round var(--node-inner-radius))'
              : 'inset(0 round 0 0 var(--node-inner-radius) var(--node-inner-radius))',
          }}
        >
          {/* Dims an unfocused node and takes presses until it is focused. */}
          <div
            data-unfocused-overlay
            onMouseDown={(e) => {
              if (isFocused || e.button !== 0 || handToolPanShouldWin(e)) return
              e.stopPropagation()
              // In a multi-selection no node is active, so presses land here;
              // the drag carries the group.
              startNodeDrag(e)
            }}
            onClick={(e) => {
              if (isFocused) return
              e.stopPropagation()
              if (canvasDrag().wasDragged()) return
              if (e.shiftKey) {
                store.getState().toggleNodeSelection(nodeId)
                return
              }
              store.getState().selectNodes([nodeId])
              focusThisNode()
            }}
            onDragEnter={(e) => {
              if (isFileDrag(e.nativeEvent)) setFileDragOver(true)
            }}
            style={{
              position: 'absolute',
              top: rootIsStack ? 26 : 0,
              left: 0,
              right: 0,
              bottom: 0,
              backgroundColor: 'var(--node-dim-overlay)',
              pointerEvents: isFocused || isDragging || fileDragOver ? 'none' : 'auto',
              cursor: isFocused ? undefined : 'default',
              zIndex: 1,
              opacity: isFocused || isDragging ? 0 : 1,
              transition: 'opacity 150ms ease',
            }}
          />
          <div
            style={{ position: 'relative', zIndex: 0, width: '100%', height: '100%' }}
            onMouseDownCapture={(e) => {
              if (e.button !== 0) return
              recordPressedLeaf(e.target)
              if (isFocused) return
              // A press on a group member starts a group drag in the bubble
              // phase; focusing here first would collapse the selection.
              if (isGroupDragMember(store.getState().selection, nodeId)) return
              focusThisNode()
            }}
          >
            <NodeDock
              workspaceId={workspaceId}
              canvasId={canvasId}
              nodeId={nodeId}
              dock={node.dock}
              onTabBarMouseDown={rootIsStack ? handleTabBarMouseDown : undefined}
              trailingControls={rootIsStack ? controls : undefined}
              dropDisabled={isWholeNodeDragSource}
            />
          </div>
        </div>
      </div>

      {!isWholeNodeDragSource && isFocused && activePanelId && canConnect && (
        <div
          data-panel-connection-handles-for={nodeId}
          style={{
            position: 'absolute',
            left: node.origin.x,
            top: node.origin.y,
            width: node.size.width,
            height: node.size.height,
            zIndex: 1200 + node.zOrder,
            pointerEvents: 'none',
          }}
        >
          <PanelRelationHandle workspaceId={workspaceId} sourcePanelId={activePanelId} />
        </div>
      )}

      {/* The resize band overhangs the border into the gutter, so it is a
          sibling of the clipped node box, positioned and stacked with it. */}
      {!isWholeNodeDragSource && (
        <div
          aria-hidden
          data-resize-frame-for={nodeId}
          style={{
            position: 'absolute',
            left: node.origin.x,
            top: node.origin.y,
            width: node.size.width,
            height: node.size.height,
            zIndex: 1000 + node.zOrder,
            pointerEvents: 'none',
          }}
        >
          <NodeResizeOverlay onResizeStart={handleResizeStartGuarded} />
        </div>
      )}
    </>
  )
}

export default React.memo(CanvasNode)
