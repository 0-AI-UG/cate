// =============================================================================
// CanvasNode — floating canvas window backed by a per-node DockStore.
// Each node owns its own DockStore (created in CanvasPanel) which manages
// its internal layout (splits, tab stacks). The outer chrome (border, resize,
// node-level drag, focus glow, activity pulse) lives here; everything inside
// is rendered via the standard dock primitives.
// =============================================================================

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRenderCount } from '../lib/perf/perfClient'
import type { StoreApi } from 'zustand'
import type { NodeActivityState, DockLayoutNode, PanelType } from '../../shared/types'
import { isMaximized as checkMaximized } from '../../shared/types'
import { useCanvasStoreContext, useCanvasStoreApi } from '../stores/CanvasStoreContext'
import { useAppStore, useSelectedWorkspace } from '../stores/appStore'
import { useUIStore } from '../stores/uiStore'
import { useDragStore, useDragSourceVisibility } from '../drag'
import { useNodeResize } from '../hooks/useNodeResize'
import { useCanvasNodeStyle } from './useCanvasNodeStyle'
import { useCanvasNodeDrag } from './useCanvasNodeDrag'
import { useGroupNodeDrag } from './useGroupNodeDrag'
import { useNodeResizeCursor } from './useNodeResizeCursor'
import { NodeResizeOverlay } from './NodeResizeOverlay'
import type { DockStore } from '../stores/dockStore'
import { DockStoreProvider } from '../stores/DockStoreContext'
import DockTabStack from '../docking/DockTabStack'
import { activeLeafPanelId } from '../panels/nodeDockRegistry'
import { setActivePanel } from '../lib/activePanel'
import { Tooltip } from '../ui/Tooltip'
import DockSplitContainer from '../docking/DockSplitContainer'
import { confirmCloseDirtyPanels } from '../lib/confirmCloseDirty'
import { confirmCloseRunningTerminals } from '../lib/confirmCloseTerminal'
import { collectPanelIds } from '../lib/canvas/collectPanelIds'
import { ArrowsOutSimple, ArrowsInSimple, X, Lock, LockOpen } from '@phosphor-icons/react'
import { PANEL_DEFINITIONS } from '../../shared/panels'

// When the Hand tool is active, a left-press on a node must pan
// the canvas instead of dragging/resizing the node. These handlers bail out
// (without stopping propagation) so the event bubbles to the canvas container's
// pan handler. Focused interactive content (terminal/monaco/webview) is handled
// separately by the `canvas-tool-hand` body class (see Canvas.tsx).
function handToolPanShouldWin(e: React.MouseEvent): boolean {
  return e.button === 0 && useUIStore.getState().activeTool === 'hand'
}

// -----------------------------------------------------------------------------
// Props
// -----------------------------------------------------------------------------

export interface CanvasNodeProps {
  nodeId: string
  isFocused: boolean
  activityState?: NodeActivityState
  /** Per-node DockStore that owns the layout for this node. Created in CanvasPanel. */
  dockStoreApi: StoreApi<DockStore>
  /** Render the panel content for a given panelId. */
  renderPanel: (panelId: string) => React.ReactNode
  /** Title used in tooltips / context when there's no dock panel. */
  title?: string
}

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const GRAB_STRIP_HEIGHT = 22
/** Canvas-inside-canvas isn't supported — tab + split menus and drag-and-drop
 *  for canvas-node mini-docks all reject this type. */
const CANVAS_EXCLUDED_TYPES: PanelType[] = ['canvas']

// -----------------------------------------------------------------------------
// Pulse animation keyframes (injected once)
// -----------------------------------------------------------------------------

const PULSE_KEYFRAMES = `
@keyframes pulseActivity {
  0% { outline-color: color-mix(in srgb, var(--activity-orange) 40%, transparent); }
  100% { outline-color: var(--activity-orange); }
}
/* Match the tab-bar's bottom border to the active tab color so it reads as
   a continuous surface instead of a hard divider. */
[data-node-id] .dock-tab-bar { border-bottom-color: var(--surface-3) !important; }
/* Hide tab-bar action icons (add/split/lock/maximize/close and per-tab X)
   when the node isn't focused — they'd just be visual noise from afar. */
[data-node-id][data-node-active="false"] .dock-tab-bar button,
[data-node-id][data-node-active="false"] .dock-tab-bar .group > span:last-child {
  opacity: 0 !important;
  pointer-events: none !important;
}
`

let keyframesInjected = false
function ensureKeyframes() {
  if (keyframesInjected) return
  if (typeof document === 'undefined') return
  const style = document.createElement('style')
  style.textContent = PULSE_KEYFRAMES
  document.head.appendChild(style)
  keyframesInjected = true
}

// -----------------------------------------------------------------------------
// Grab strip button — tiny icon button with hover state via inline handlers
// -----------------------------------------------------------------------------

function GrabButton({
  title,
  onClick,
  color,
  children,
}: {
  title: string
  onClick: (e: React.MouseEvent) => void
  color?: string
  children: React.ReactNode
}) {
  const baseColor = color ?? 'var(--text-secondary)'
  return (
    <Tooltip label={title}>
      <button
        data-grab-button
        aria-label={title}
        onClick={onClick}
        className="flex items-center justify-center w-[18px] h-[18px] rounded text-secondary hover:text-primary hover:bg-hover"
        style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: baseColor }}
      >
        {children}
      </button>
    </Tooltip>
  )
}

const TAB_ICON_SIZE = 12

// -----------------------------------------------------------------------------
// Component
// -----------------------------------------------------------------------------

const CanvasNode: React.FC<CanvasNodeProps> = ({
  nodeId,
  isFocused,
  activityState,
  dockStoreApi,
  renderPanel,
  title: _title = 'Panel',
}) => {
  ensureKeyframes()
  useRenderCount('CanvasNode')

  const canvasApi = useCanvasStoreApi()
  const nodeRef = useRef<HTMLDivElement>(null)
  const [isHovered, setIsHovered] = useState(false)
  const [isAnimatingLayout, setIsAnimatingLayout] = useState(false)
  const animationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const node = useCanvasStoreContext(
    (s) => s.nodes[nodeId],
    (a, b) => {
      if (a === b) return true
      if (!a || !b) return false
      return (
        a.origin.x === b.origin.x &&
        a.origin.y === b.origin.y &&
        a.size.width === b.size.width &&
        a.size.height === b.size.height &&
        a.zOrder === b.zOrder &&
        a.isPinned === b.isPinned &&
        a.animationState === b.animationState
      )
    },
  )
  const focusNode = useCanvasStoreContext((s) => s.focusNode)
  const removeNode = useCanvasStoreContext((s) => s.removeNode)
  const toggleMaximize = useCanvasStoreContext((s) => s.toggleMaximize)
  const isSelected = useCanvasStoreContext((s) => s.selectedNodeIds.has(nodeId))
  const isDockDragging = useDragStore((s) => s.isDragging)
  const { hidden: isWholeNodeDragSource } = useDragSourceVisibility(nodeId)

  // Drag dispatch (whole-node + single-tab detach) + primaryPanel derivation.
  const {
    handleDragStart,
    handleTabDetachStart,
    primaryPanel,
    primaryPanelType,
    layout,
    wasDragged,
  } = useCanvasNodeDrag(nodeId, dockStoreApi, canvasApi)

  // Group move: when this node is part of a multi-selection, dragging it moves
  // the whole selection together instead of running the single-node dock drag.
  const { startGroupDrag } = useGroupNodeDrag(nodeId, canvasApi, wasDragged)

  // Wrap node-drag with the tab-vs-window routing. The tab bar uses this for
  // both empty-area mousedown (panelId undefined → whole node drag) and
  // individual tab mousedown (panelId set → detach that tab when the mini-dock
  // has multiple panels, else whole-node drag).
  const handleHeaderMouseDown = useCallback((e: React.MouseEvent, panelId?: string) => {
    if (handToolPanShouldWin(e)) return
    if (startGroupDrag(e)) return
    if (panelId) {
      const total = collectPanelIds(dockStoreApi.getState().zones.center.layout).length
      if (total > 1) {
        handleTabDetachStart(e, panelId)
        return
      }
    }
    handleDragStart(e)
  }, [handleDragStart, handleTabDetachStart, dockStoreApi, startGroupDrag])

  const maximized = node ? checkMaximized(node) : false

  const { handleResizeStart } = useNodeResize(nodeId, primaryPanelType, canvasApi)
  // Under the Hand tool, edge presses pan instead of resizing.
  const handleResizeStartGuarded = useCallback(
    (e: React.MouseEvent, edge: Parameters<typeof handleResizeStart>[1]) => {
      if (handToolPanShouldWin(e)) return
      handleResizeStart(e, edge)
    },
    [handleResizeStart],
  )
  const { handleMouseDown } = useNodeResizeCursor()
  const wsId = useAppStore((s) => s.selectedWorkspaceId)
  const currentWorkspace = useSelectedWorkspace()

  // Terminals follow the single unified theme, so node chrome is never tinted
  // per-panel any more.
  const chromeTint = null

  // --- Animation lifecycle ---------------------------------------------------

  useEffect(() => {
    if (!node) return

    if (node.animationState === 'entering') {
      let innerRaf = 0
      const outerRaf = requestAnimationFrame(() => {
        innerRaf = requestAnimationFrame(() => {
          canvasApi.getState().setNodeAnimationState(nodeId, 'idle')
        })
      })
      return () => {
        cancelAnimationFrame(outerRaf)
        cancelAnimationFrame(innerRaf)
      }
    }

    if (node.animationState === 'exiting') {
      // Under e2e the window is hidden (throttled compositor) and animations are
      // disabled — finalize removal immediately so "node is gone" assertions
      // don't race the 200ms exit delay.
      const exitDelay = window.electronAPI?.isE2E ? 0 : 200
      const timer = setTimeout(() => {
        canvasApi.getState().finalizeRemoveNode(nodeId)
      }, exitDelay)
      animationTimerRef.current = timer
      return () => clearTimeout(timer)
    }
  }, [node?.animationState, nodeId])

  // --- Dock layout renderer --------------------------------------------------

  const resolvePanel = useCallback(
    (panelId: string) => {
      const p = currentWorkspace?.panels[panelId]
      if (p) return p
      const s = useAppStore.getState()
      const ws = s.workspaces.find((w) => w.id === s.selectedWorkspaceId)
      return ws?.panels[panelId]
    },
    [currentWorkspace],
  )

  const getPanelTitle = useCallback(
    (panelId: string) => {
      const p = resolvePanel(panelId)
      if (p?.title) return p.title
      if (p?.type) return PANEL_DEFINITIONS[p.type]?.label ?? 'Panel'
      return 'Panel'
    },
    [resolvePanel],
  )

  const getPanel = useCallback((panelId: string) => resolvePanel(panelId), [resolvePanel])

  const confirmCloseForPanels = useCallback(
    async (panelIds: string[]): Promise<boolean> => {
      const ws = useAppStore.getState().workspaces.find((w) => w.id === wsId)
      if (!ws) return true
      const panels = panelIds.map((id) => ws.panels[id])
      if (!(await confirmCloseDirtyPanels(panels))) return false
      if (!(await confirmCloseRunningTerminals(panels))) return false
      return true
    },
    [wsId],
  )

  const handleClosePanel = useCallback(
    async (panelId: string) => {
      const ok = await confirmCloseForPanels([panelId])
      if (!ok) return
      dockStoreApi.getState().undockPanel(panelId)
      useAppStore.getState().closePanel(wsId, panelId)
    },
    [dockStoreApi, wsId, confirmCloseForPanels],
  )

  // A tab was detached into its own window via the "Move into New Window" menu
  // action. moveTabToNewWindow undocks the panel from this mini-dock but can't
  // know it lives inside a canvas node — so if that emptied the node, remove it
  // here. Mirrors the drag-out path (removeFromSource → finalizeRemoveNode) so a
  // single-panel node leaves the canvas instead of lingering as an empty husk.
  const handlePanelRemoved = useCallback(() => {
    const remaining = collectPanelIds(dockStoreApi.getState().zones.center.layout)
    if (remaining.length === 0) canvasApi.getState().finalizeRemoveNode(nodeId)
  }, [dockStoreApi, canvasApi, nodeId])

  const handleClose = useCallback(async () => {
    const panelIds = collectPanelIds(layout)
    const ok = await confirmCloseForPanels(panelIds)
    if (!ok) return
    for (const panelId of panelIds) {
      useAppStore.getState().closePanel(wsId, panelId)
    }
    removeNode(nodeId)
  }, [removeNode, nodeId, layout, confirmCloseForPanels, wsId])

  const handleToggleMaximize = useCallback(() => {
    setIsAnimatingLayout(true)
    const viewportSize = { width: window.innerWidth, height: window.innerHeight }
    toggleMaximize(nodeId, viewportSize)
    setTimeout(() => setIsAnimatingLayout(false), 300)
  }, [toggleMaximize, nodeId])

  // Spring-load: when ANY dock drag is active AND this node is maximized
  // (covering the canvas), un-maximize after a short delay so the user can
  // see the canvas underneath and target a drop point.
  const toggleMaximizeRef = useRef(handleToggleMaximize)
  toggleMaximizeRef.current = handleToggleMaximize
  const maximizedRef = useRef(maximized)
  maximizedRef.current = maximized
  useEffect(() => {
    let timerId: number | null = null
    const tryArm = () => {
      const s = useDragStore.getState()
      if (!s.isDragging || s.panel?.type === 'canvas') return
      if (!maximizedRef.current) return
      if (timerId !== null) return
      timerId = window.setTimeout(() => {
        timerId = null
        if (maximizedRef.current) toggleMaximizeRef.current()
      }, 200)
    }
    const cancel = () => {
      if (timerId !== null) { window.clearTimeout(timerId); timerId = null }
    }
    tryArm()
    const unsub = useDragStore.subscribe((s, prev) => {
      if (s.isDragging && !prev.isDragging) tryArm()
      else if (!s.isDragging && prev.isDragging) cancel()
    })
    return () => { cancel(); unsub() }
  }, [])

  const handleTogglePin = useCallback(() => {
    canvasApi.getState().togglePin(nodeId)
  }, [nodeId])

  // Walk the layout to the currently active leaf panel so the worktree pill
  // reflects the visible tab when this node hosts multiple panels.
  const activePanel = useMemo(() => {
    const id = activeLeafPanelId(layout)
    if (!id) return primaryPanel
    return currentWorkspace?.panels[id] ?? primaryPanel
  }, [layout, currentWorkspace, primaryPanel])

  // --- Worktree identity: follows the ACTIVE tab --------------------------
  // The node adopts whichever tab is open. Gated on 2+ worktrees (matching the
  // chip) so single-branch flows show no tint/sludge.
  const worktrees = currentWorkspace?.worktrees ?? []
  const wtEnabled = worktrees.length >= 2
  // Resolve the active tab's worktree. A terminal/agent panel with no explicit
  // tag belongs to the PRIMARY worktree (the record keyed by the workspace root),
  // so the main checkout gets the same tint / terrace / focus-lens as the others
  // — mirroring the WorktreePill + tab-title fallback. Non-terminal panels stay
  // untagged (no territory).
  const primaryWorktree = worktrees.find((w) => w.path === currentWorkspace?.rootPath)
  const isWorktreePanel = activePanel?.type === 'terminal' || activePanel?.type === 'agent'
  const activeWorktree = wtEnabled
    ? worktrees.find((w) => w.id === activePanel?.worktreeId) ?? (isWorktreePanel ? primaryWorktree : undefined)
    : undefined
  const activeWorktreeId = activeWorktree?.id ?? null
  const worktreeColor = activeWorktree?.color ?? null
  const hoveredWorktreeId = useUIStore((s) => s.hoveredWorktreeId)
  const focusedWorktreeId = useUIStore((s) => s.focusedWorktreeId)
  const worktreeHighlight =
    !!activeWorktreeId &&
    (hoveredWorktreeId === activeWorktreeId || focusedWorktreeId === activeWorktreeId)
  const worktreeDim = !!focusedWorktreeId && activeWorktreeId !== focusedWorktreeId

  // Publish the active-tab worktree for the global sludge/lens layers, which
  // live outside this node's dock store and can't read its active tab directly.
  useEffect(() => {
    canvasApi.getState().setNodeActiveWorktree(nodeId, activeWorktreeId)
  }, [nodeId, activeWorktreeId, canvasApi])
  // Clear only on unmount (not on every change) so the sludge never flickers.
  useEffect(() => {
    return () => canvasApi.getState().setNodeActiveWorktree(nodeId, null)
  }, [nodeId, canvasApi])

  const nodeControlButtons = (
    <>
      <GrabButton
        title={node?.isPinned ? 'Unlock' : 'Lock'}
        onClick={(e) => { e.stopPropagation(); handleTogglePin() }}
        color={node?.isPinned ? 'var(--focus-blue)' : undefined}
      >
        {node?.isPinned
          ? <Lock size={TAB_ICON_SIZE} />
          : <LockOpen size={TAB_ICON_SIZE} />}
      </GrabButton>
      <GrabButton
        title={maximized ? 'Restore' : 'Maximize'}
        onClick={(e) => { e.stopPropagation(); handleToggleMaximize() }}
      >
        {maximized
          ? <ArrowsInSimple size={TAB_ICON_SIZE} />
          : <ArrowsOutSimple size={TAB_ICON_SIZE} />}
      </GrabButton>
      <GrabButton
        title="Close"
        onClick={(e) => { e.stopPropagation(); handleClose() }}
      >
        <X size={TAB_ICON_SIZE} />
      </GrabButton>
    </>
  )

  const rootIsTabs = layout?.type === 'tabs'

  const renderLayoutNodeRef = useRef<(node: DockLayoutNode, isRoot: boolean) => React.ReactNode>(null!)
  renderLayoutNodeRef.current = (layoutNode: DockLayoutNode, isRoot: boolean): React.ReactNode => {
    if (layoutNode.type === 'tabs') {
      const isHeaderHost = isRoot && rootIsTabs
      return (
        <DockTabStack
          stack={layoutNode}
          zone="center"
          renderPanel={renderPanel}
          getPanelTitle={getPanelTitle}
          getPanel={getPanel}
          onClosePanel={handleClosePanel}
          onPanelRemoved={handlePanelRemoved}
          excludePanelTypes={CANVAS_EXCLUDED_TYPES}
          localOnly
          compact
          onTabBarMouseDown={isHeaderHost ? handleHeaderMouseDown : undefined}
          trailingControls={isHeaderHost ? nodeControlButtons : undefined}
          dropDisabled={isWholeNodeDragSource}
        />
      )
    }
    return (
      <DockSplitContainer
        node={layoutNode}
        renderNode={(n) => renderLayoutNodeRef.current(n, false)}
      />
    )
  }
  const renderLayoutNode = useCallback(
    (layoutNode: DockLayoutNode) => renderLayoutNodeRef.current(layoutNode, true),
    // intentionally no deps — the ref is rebound on every render
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  // --- Event handlers --------------------------------------------------------

  // Focus this node AND point the canonical active-panel pointer at its active
  // leaf (the visible dock tab), not the node's seed panelId. This is the bridge
  // that makes terminal-focus detection (and Cmd+T placement) correct for a node
  // whose mini-dock holds several panels. The subscription below re-asserts it on
  // every tab switch while focused; this covers the initial focus.
  const focusThisNode = useCallback(() => {
    focusNode(nodeId)
    const leaf = activeLeafPanelId(dockStoreApi.getState().zones.center.layout)
    setActivePanel(leaf ?? node?.panelId ?? null)
  }, [focusNode, nodeId, dockStoreApi, node?.panelId])

  // Authoritative writer for the active panel while this node is focused: any
  // center-layout change (tab switch, split, close) re-points activePanelId at
  // the new active leaf. Gated on focus so a background node's tab activity never
  // steals the pointer. This also wins the focus-race against
  // CanvasPanel.handlePointerDown, which re-asserts the canvas-container id right
  // after a click — that fires first (pointerdown), this fires last.
  const isFocusedRef = useRef(isFocused)
  isFocusedRef.current = isFocused
  useEffect(() => {
    // Re-assert on becoming focused (the click path already did, but a focus
    // change via keyboard nav goes through focusNode without focusThisNode).
    if (isFocused) {
      const leaf = activeLeafPanelId(dockStoreApi.getState().zones.center.layout)
      if (leaf) setActivePanel(leaf)
    }
    let prevLeaf = activeLeafPanelId(dockStoreApi.getState().zones.center.layout)
    const unsub = dockStoreApi.subscribe((s) => {
      const leaf = activeLeafPanelId(s.zones.center.layout)
      if (leaf === prevLeaf) return
      prevLeaf = leaf
      if (isFocusedRef.current && leaf) setActivePanel(leaf)
    })
    return unsub
  }, [dockStoreApi, isFocused])

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      if (wasDragged.current) return
      // Hand tool: clicks pan/move only — never select.
      if (useUIStore.getState().activeTool === 'hand') return
      if (e.shiftKey) {
        canvasApi.getState().toggleNodeSelection(nodeId)
        return
      }
      canvasApi.getState().selectNodes([nodeId])
      if (!isFocused) {
        focusThisNode()
      }
    },
    [isFocused, focusThisNode, nodeId, wasDragged],
  )

  // Grab strip: double-click toggles maximize, drag moves node
  const handleGrabStripMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return
      if (handToolPanShouldWin(e)) return
      const target = e.target as HTMLElement
      if (target.closest('[data-grab-button]')) return
      e.stopPropagation()
      if (e.detail === 2) {
        handleToggleMaximize()
        return
      }
      if (startGroupDrag(e)) return
      handleDragStart(e)
    },
    [handleDragStart, handleToggleMaximize, startGroupDrag],
  )

  const handleGrabStripContextMenu = useCallback(
    async (e: React.MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (!window.electronAPI) return
      const id = await window.electronAPI.showContextMenu([
        { id: 'maximize', label: maximized ? 'Restore' : 'Maximize' },
        { id: 'pin', label: node?.isPinned ? 'Unlock' : 'Lock' },
        { type: 'separator' },
        { id: 'front', label: 'Move to Front' },
        { id: 'back', label: 'Move to Back' },
        { type: 'separator' },
        { id: 'close', label: 'Close', accelerator: 'Cmd+W' },
      ])
      switch (id) {
        case 'maximize': handleToggleMaximize(); break
        case 'pin': handleTogglePin(); break
        case 'front': canvasApi.getState().moveToFront(nodeId); break
        case 'back': canvasApi.getState().moveToBack(nodeId); break
        case 'close': handleClose(); break
      }
    },
    [maximized, node?.isPinned, handleToggleMaximize, handleTogglePin, handleClose, canvasApi, nodeId],
  )

  // --- Computed styles -------------------------------------------------------

  const { containerStyle, glowStyle } = useCanvasNodeStyle({
    node,
    isFocused,
    isSelected,
    activityState,
    isAnimatingLayout,
    isHovered,
    chromeTint,
    isWholeNodeDragSource,
    worktreeColor,
    worktreeHighlight,
    worktreeDim,
  })

  if (!node) return null

  return (
    <>
    {glowStyle && <div aria-hidden data-glow-for={nodeId} style={glowStyle} />}
    <div
      ref={nodeRef}
      data-node-id={nodeId}
      data-node-active={isFocused ? 'true' : 'false'}
      style={containerStyle}
      onClick={handleClick}
      onMouseDown={handleMouseDown}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {/* Standalone grab strip — only when the layout is split (or empty). */}
      {!rootIsTabs && (
        <div
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
            {nodeControlButtons}
          </div>
        </div>
      )}

      {/* Dock layout area */}
      <div
        data-panel-content
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) {
            const overlay = e.currentTarget.querySelector<HTMLElement>('[data-unfocused-overlay]')
            if (overlay && !isFocused) overlay.style.pointerEvents = 'auto'
          }
        }}
        onDrop={() => {
          const el = nodeRef.current?.querySelector<HTMLElement>('[data-unfocused-overlay]')
          if (el && !isFocused) el.style.pointerEvents = 'auto'
        }}
        style={{
          position: 'relative',
          height: rootIsTabs ? '100%' : `calc(100% - ${GRAB_STRIP_HEIGHT}px)`,
          overflow: 'hidden',
        }}
      >
        {/* Unfocused dim overlay — intercepts pointer events until node is focused. */}
        <div
          data-unfocused-overlay
          onMouseDown={(e) => {
            if (isFocused || e.button !== 0) return
            if (handToolPanShouldWin(e)) return
            e.stopPropagation()
            handleDragStart(e)
          }}
          onClick={(e) => {
            if (isFocused) return
            e.stopPropagation()
            if (wasDragged.current) return
            if (e.shiftKey) {
              canvasApi.getState().toggleNodeSelection(nodeId)
              return
            }
            canvasApi.getState().selectNodes([nodeId])
            focusThisNode()
          }}
          onDragEnter={(e) => {
            if (
              e.dataTransfer.types.includes('Files') ||
              e.dataTransfer.types.includes('application/cate-file')
            ) {
              ;(e.currentTarget as HTMLElement).style.pointerEvents = 'none'
            }
          }}
          style={{
            position: 'absolute',
            top: rootIsTabs ? 26 : 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'var(--node-dim-overlay)',
            pointerEvents: isFocused || isDockDragging ? 'none' : 'auto',
            cursor: isFocused ? undefined : 'default',
            zIndex: 1,
            opacity: isFocused || isDockDragging ? 0 : 1,
            transition: 'opacity 150ms ease',
          }}
        />

        {/* Dock primitives */}
        <DockStoreProvider store={dockStoreApi}>
          <div
            style={{ position: 'relative', zIndex: 0, width: '100%', height: '100%' }}
            onMouseDownCapture={(e) => {
              if (e.button !== 0 || isFocused) return
              focusThisNode()
            }}
          >
            {layout ? renderLayoutNode(layout) : (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-muted)', fontSize: 12 }}>
                Empty
              </div>
            )}
          </div>
        </DockStoreProvider>
      </div>
    </div>

    {/* Resize band — sits just OUTSIDE the panel border, in the canvas gutter,
        so it never overlaps the panel interior or its content scrollbar.
        Mounted as a sibling (not inside the node's overflow:hidden box) so the
        strips can overhang the edge; positioned to the node's bounds and
        stacked with it. */}
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

export default React.memo(CanvasNode, (prev, next) => {
  return (
    prev.nodeId === next.nodeId &&
    prev.isFocused === next.isFocused &&
    prev.activityState === next.activityState &&
    prev.dockStoreApi === next.dockStoreApi &&
    prev.renderPanel === next.renderPanel &&
    prev.title === next.title
  )
})
