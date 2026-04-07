// =============================================================================
// CanvasNode — floating canvas window backed by a per-node DockStore.
// Each node owns its own DockStore (created in CanvasPanel) which manages
// its internal layout (splits, tab stacks). The outer chrome (border, resize,
// node-level drag, focus glow, activity pulse) lives here; everything inside
// is rendered via the standard dock primitives.
// =============================================================================

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from 'zustand'
import type { StoreApi } from 'zustand'
import type { NodeActivityState, DockLayoutNode, PanelType } from '../../shared/types'
import { isMaximized as checkMaximized } from '../../shared/types'
import { useCanvasStoreContext, useCanvasStoreApi } from '../stores/CanvasStoreContext'
import { useAppStore, useSelectedWorkspace } from '../stores/appStore'
import { useNodeDrag } from '../hooks/useNodeDrag'
import { useNodeResize, detectEdge, getCursorForEdge } from '../hooks/useNodeResize'
import type { DockStore } from '../stores/dockStore'
import { DockStoreProvider } from '../stores/DockStoreContext'
import DockTabStack from '../docking/DockTabStack'
import DockSplitContainer from '../docking/DockSplitContainer'
import { saveEditor } from '../lib/editorSaveRegistry'
import { ArrowsOutSimple, ArrowsInSimple, X, Lock, LockOpen } from '@phosphor-icons/react'

// -----------------------------------------------------------------------------
// Props
// -----------------------------------------------------------------------------

export interface CanvasNodeProps {
  nodeId: string
  isFocused: boolean
  activityState?: NodeActivityState
  zoomLevel: number
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
const CORNER_RADIUS = 8
/** Canvas-inside-canvas isn't supported — tab + split menus and drag-and-drop
 *  for canvas-node mini-docks all reject this type. */
const CANVAS_EXCLUDED_TYPES: PanelType[] = ['canvas']

// -----------------------------------------------------------------------------
// Styles
// -----------------------------------------------------------------------------

function borderColor(focused: boolean): string {
  return focused ? 'rgba(74, 158, 255, 0.5)' : 'rgba(255, 255, 255, 0.1)'
}

const SCALE = 'calc(1/max(var(--zoom,1),0.3))'
const SHADOW_FOCUSED = `0 calc(-2*${SCALE}) calc(8*${SCALE}) rgba(74,158,255,0.3)`
const SHADOW_UNFOCUSED = `0 calc(-1*${SCALE}) calc(4*${SCALE}) rgba(0,0,0,0.3)`
const SHADOW_HOVERED = `${SHADOW_UNFOCUSED}, 0 calc(-2*${SCALE}) calc(6*${SCALE}) rgba(255,255,255,0.15)`

function boxShadow(focused: boolean, hovered: boolean): string {
  if (focused) return SHADOW_FOCUSED
  if (hovered) return SHADOW_HOVERED
  return SHADOW_UNFOCUSED
}

function activityOutline(activity: NodeActivityState | undefined): string {
  if (!activity) return 'none'
  switch (activity.type) {
    case 'commandFinished':
      return '2px solid rgba(77, 217, 100, 0.7)'
    case 'agentWaitingForInput':
      return '2px solid rgba(255, 149, 0, 0.8)'
    default:
      return 'none'
  }
}

// -----------------------------------------------------------------------------
// Pulse animation keyframes (injected once)
// -----------------------------------------------------------------------------

const PULSE_KEYFRAMES = `
@keyframes pulseActivity {
  0% { outline-color: rgba(255, 149, 0, 0.4); }
  100% { outline-color: rgba(255, 149, 0, 1.0); }
}
/* Match the tab-bar's bottom border to the active tab color so it reads as
   a continuous surface instead of a hard divider. */
[data-node-id] .dock-tab-bar { border-bottom-color: #1f1e1c !important; }
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

/** Icon button used in the canvas-node tab bar trailing controls. Sized to
 *  match the existing +/split buttons in DockTabStack's compact mode so the
 *  whole row of icons (+ split lock maximize close) is visually consistent. */
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
  const baseColor = color ?? 'rgba(255,255,255,0.55)'
  return (
    <button
      data-grab-button
      title={title}
      onClick={onClick}
      className="flex items-center justify-center w-[18px] h-[18px] rounded text-white/55 hover:text-white/90 hover:bg-white/10"
      style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: baseColor }}
    >
      {children}
    </button>
  )
}

/** Standard icon size + stroke for all canvas-node tab-bar icons. */
const TAB_ICON_SIZE = 12

// -----------------------------------------------------------------------------
// Component
// -----------------------------------------------------------------------------

const CanvasNode: React.FC<CanvasNodeProps> = ({
  nodeId,
  isFocused,
  activityState,
  zoomLevel,
  dockStoreApi,
  renderPanel,
  title = 'Panel',
}) => {
  ensureKeyframes()

  const canvasApi = useCanvasStoreApi()
  const nodeRef = useRef<HTMLDivElement>(null)
  const [isHovered, setIsHovered] = useState(false)
  const [isAnimatingLayout, setIsAnimatingLayout] = useState(false)
  const animationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const node = useCanvasStoreContext((s) => s.nodes[nodeId])
  const focusNode = useCanvasStoreContext((s) => s.focusNode)
  const removeNode = useCanvasStoreContext((s) => s.removeNode)
  const toggleMaximize = useCanvasStoreContext((s) => s.toggleMaximize)
  const isSelected = useCanvasStoreContext((s) => s.selectedNodeIds.has(nodeId))

  const { handleDragStart, wasDragged } = useNodeDrag(nodeId, zoomLevel, canvasApi)

  const maximized = node ? checkMaximized(node) : false

  // Read the dock layout from the per-node store reactively
  const layout = useStore(dockStoreApi, (s) => s.zones.center.layout)

  const currentWorkspace = useSelectedWorkspace()

  // Derive the primary panel type for minimum-size constraints (uses first leaf panel).
  const primaryPanelType = useMemo<PanelType>(() => {
    function firstPanelId(n: DockLayoutNode | null): string | null {
      if (!n) return null
      if (n.type === 'tabs') return n.panelIds[0] ?? null
      for (const child of n.children) {
        const found = firstPanelId(child)
        if (found) return found
      }
      return null
    }
    const pid = firstPanelId(layout)
    if (!pid) return 'editor'
    return currentWorkspace?.panels[pid]?.type ?? 'editor'
  }, [layout, currentWorkspace])

  const { handleResizeStart } = useNodeResize(nodeId, primaryPanelType, zoomLevel, canvasApi)
  const wsId = useAppStore((s) => s.selectedWorkspaceId)

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
      const timer = setTimeout(() => {
        canvasApi.getState().finalizeRemoveNode(nodeId)
      }, 200)
      animationTimerRef.current = timer
      return () => clearTimeout(timer)
    }
  }, [node?.animationState, nodeId])

  // --- Dock layout renderer --------------------------------------------------

  const getPanelTitle = useCallback(
    (panelId: string) => currentWorkspace?.panels[panelId]?.title ?? 'Panel',
    [currentWorkspace],
  )

  const getPanel = useCallback(
    (panelId: string) => currentWorkspace?.panels[panelId],
    [currentWorkspace],
  )

  // Collect all panel ids contained in a dock layout subtree.
  const collectPanelIds = useCallback((n: DockLayoutNode | null): string[] => {
    if (!n) return []
    if (n.type === 'tabs') return [...n.panelIds]
    const out: string[] = []
    for (const child of n.children) out.push(...collectPanelIds(child))
    return out
  }, [])

  // Prompt the user via a native dialog if any of the given panels are dirty
  // editors. Returns true if the close should proceed.
  const confirmCloseForPanels = useCallback(
    async (panelIds: string[]): Promise<boolean> => {
      const ws = useAppStore.getState().workspaces.find((w) => w.id === wsId)
      if (!ws) return true
      const dirty = panelIds
        .map((id) => ws.panels[id])
        .filter((p): p is NonNullable<typeof p> => !!p && p.type === 'editor' && !!p.isDirty)
      if (dirty.length === 0) return true
      if (!window.electronAPI?.confirmUnsavedChanges) return true
      const fileName =
        dirty.length === 1
          ? dirty[0].title.replace(/\s•\s*$/, '').trim()
          : `${dirty.length} files`
      const choice = await window.electronAPI.confirmUnsavedChanges({
        fileName,
        multiple: dirty.length > 1,
      })
      if (choice === 'cancel') return false
      if (choice === 'save') {
        for (const p of dirty) {
          try { await saveEditor(p.id) } catch { /* swallow — user can retry */ }
        }
      }
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

  const handleClose = useCallback(async () => {
    const ok = await confirmCloseForPanels(collectPanelIds(layout))
    if (!ok) return
    removeNode(nodeId)
  }, [removeNode, nodeId, layout, collectPanelIds, confirmCloseForPanels])

  const handleToggleMaximize = useCallback(() => {
    setIsAnimatingLayout(true)
    const viewportSize = { width: window.innerWidth, height: window.innerHeight }
    toggleMaximize(nodeId, viewportSize)
    setTimeout(() => setIsAnimatingLayout(false), 300)
  }, [toggleMaximize, nodeId])

  const handleTogglePin = useCallback(() => {
    canvasApi.getState().togglePin(nodeId)
  }, [nodeId])

  // Lock / maximize / close — the same buttons whether they live on the
  // standalone grab strip (when the layout is split) or injected into the
  // leaf tab bar (when the root layout is a single stack).
  const nodeControlButtons = (
    <>
      <GrabButton
        title={node?.isPinned ? 'Unlock' : 'Lock'}
        onClick={(e) => { e.stopPropagation(); handleTogglePin() }}
        color={node?.isPinned ? 'rgba(96,165,250,0.85)' : undefined}
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

  // Renderer for the per-node dock layout. Uses a ref so the recursive call
  // inside DockSplitContainer always sees the latest closure (avoids stale
  // captures in useCallback).
  // The `isRoot` flag controls which leaf gets the node-level trailing
  // controls (lock / maximize / close) and the empty-tab-bar drag handler.
  // - If the root layout is a single tab stack, that stack hosts the controls
  //   and there's no separate top grab strip — one bar to rule them all.
  // - If the root layout is a split, controls live on a tiny grab strip above
  //   the layout (rendered separately), and no leaf gets trailingControls.
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
          excludePanelTypes={CANVAS_EXCLUDED_TYPES}
          localOnly
          compact
          onTabBarMouseDown={isHeaderHost ? handleDragStart : undefined}
          trailingControls={isHeaderHost ? nodeControlButtons : undefined}
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

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      if (wasDragged.current) return
      if (e.shiftKey) {
        canvasApi.getState().toggleNodeSelection(nodeId)
        return
      }
      canvasApi.getState().selectNodes([nodeId])
      if (!isFocused) {
        focusNode(nodeId)
      }
    },
    [isFocused, focusNode, nodeId, wasDragged],
  )

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button === 2) {
        e.stopPropagation()
        return
      }
      if (e.button !== 0) return
      if (!nodeRef.current || !node) return

      const rect = nodeRef.current.getBoundingClientRect()
      const localX = e.clientX - rect.left
      const localY = e.clientY - rect.top

      const edge = detectEdge(localX, localY, rect.width, rect.height, zoomLevel)
      if (edge) {
        handleResizeStart(e, edge)
      }
    },
    [node, zoomLevel, handleResizeStart],
  )

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!nodeRef.current) return
      if (document.body.classList.contains('canvas-interacting')) return
      const rect = nodeRef.current.getBoundingClientRect()
      const localX = e.clientX - rect.left
      const localY = e.clientY - rect.top
      const edge = detectEdge(localX, localY, rect.width, rect.height, zoomLevel)
      const cursor = getCursorForEdge(edge)
      if (nodeRef.current.style.cursor !== cursor) {
        nodeRef.current.style.cursor = cursor
      }
    },
    [zoomLevel],
  )

  // Grab strip: double-click toggles maximize, drag moves node
  const handleGrabStripMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return
      const target = e.target as HTMLElement
      if (target.closest('[data-grab-button]')) return
      e.stopPropagation()
      if (e.detail === 2) {
        handleToggleMaximize()
        return
      }
      handleDragStart(e)
    },
    [handleDragStart, handleToggleMaximize],
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

  const containerStyle = useMemo<React.CSSProperties>(() => {
    if (!node) return { display: 'none' }

    const isPulsing = activityState?.type === 'agentWaitingForInput'
    const isEntering = node.animationState === 'entering'
    const isExiting = node.animationState === 'exiting'

    const baseTransition =
      'border-color 150ms ease, box-shadow 200ms ease, outline-color 200ms ease, transform 200ms cubic-bezier(0.34, 1.56, 0.64, 1), opacity 150ms ease-out'
    const layoutTransition = isAnimatingLayout
      ? ', left 250ms cubic-bezier(0.16, 1, 0.3, 1), top 250ms cubic-bezier(0.16, 1, 0.3, 1), width 250ms cubic-bezier(0.16, 1, 0.3, 1), height 250ms cubic-bezier(0.16, 1, 0.3, 1)'
      : ''

    return {
      position: 'absolute',
      left: node.origin.x,
      top: node.origin.y,
      width: node.size.width,
      height: node.size.height,
      zIndex: 1000 + node.zOrder,
      borderRadius: CORNER_RADIUS,
      overflow: 'hidden',
      border: `1.5px solid ${isSelected ? 'rgba(74, 158, 255, 0.8)' : borderColor(isFocused)}`,
      boxShadow: boxShadow(isFocused, isHovered),
      outline: activityOutline(activityState),
      outlineOffset: -1,
      animation: isPulsing ? 'pulseActivity 1s ease-in-out infinite alternate' : undefined,
      backgroundColor: '#1f1e1c',
      transition: baseTransition + layoutTransition,
      transform: isEntering ? 'scale(0.85)' : isExiting ? 'scale(0.9)' : 'scale(1)',
      opacity: isEntering ? 0 : isExiting ? 0 : 1,
      pointerEvents: isExiting ? 'none' : undefined,
      userSelect: 'none',
    }
  }, [node, isFocused, isSelected, activityState, zoomLevel, isAnimatingLayout, isHovered])

  if (!node) return null

  return (
    <div
      ref={nodeRef}
      data-node-id={nodeId}
      data-node-active={isFocused ? 'true' : 'false'}
      style={containerStyle}
      onClick={handleClick}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {/* Standalone grab strip — only when the layout is split (or empty).
          When the root layout is a single tab stack, controls live inside the
          tab bar via DockTabStack's trailingControls and there is no separate
          strip. */}
      {!rootIsTabs && (
        <div
          style={{
            height: GRAB_STRIP_HEIGHT,
            display: 'flex',
            alignItems: 'center',
            backgroundColor: '#161513',
            borderBottom: '1px solid rgba(255,255,255,0.05)',
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
        {/* Unfocused dim overlay — intercepts pointer events until node is focused.
            Dragging on this overlay moves the whole node (not the panel content). */}
        <div
          data-unfocused-overlay
          onMouseDown={(e) => {
            if (isFocused || e.button !== 0) return
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
            focusNode(nodeId)
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
            inset: 0,
            backgroundColor: 'rgba(0, 0, 0, 0.15)',
            pointerEvents: isFocused ? 'none' : 'auto',
            cursor: isFocused ? undefined : 'default',
            zIndex: 1,
            opacity: isFocused ? 0 : 1,
            transition: 'opacity 150ms ease',
          }}
        />

        {/* Dock primitives */}
        <DockStoreProvider store={dockStoreApi}>
          <div style={{ position: 'relative', zIndex: 0, width: '100%', height: '100%' }}>
            {layout ? renderLayoutNode(layout) : (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'rgba(255,255,255,0.3)', fontSize: 12 }}>
                Empty
              </div>
            )}
          </div>
        </DockStoreProvider>
      </div>

    </div>
  )
}

export default React.memo(CanvasNode)
