// =============================================================================
// CanvasNode — floating canvas window backed by a per-node DockStore.
// Each node owns its own DockStore (created in CanvasPanel) which manages
// its internal layout (splits, tab stacks). The outer chrome (border, resize,
// node-level drag, focus glow, activity pulse) lives here; everything inside
// is rendered via the standard dock primitives.
// =============================================================================

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { StoreApi } from 'zustand'
import type { NodeActivityState, DockLayoutNode, PanelType } from '../../shared/types'
import { isMaximized as checkMaximized } from '../../shared/types'
import { useCanvasStoreContext, useCanvasStoreApi } from '../stores/CanvasStoreContext'
import { useAppStore, useSelectedWorkspace } from '../stores/appStore'
import { useDragStore, useDragSourceVisibility } from '../drag'
import { useNodeResize } from '../hooks/useNodeResize'
import { useCanvasNodeStyle } from './useCanvasNodeStyle'
import { useCanvasNodeDrag, countPanels } from './useCanvasNodeDrag'
import { useNodeResizeCursor } from './useNodeResizeCursor'
import type { DockStore } from '../stores/dockStore'
import { DockStoreProvider } from '../stores/DockStoreContext'
import DockTabStack from '../docking/DockTabStack'
import DockSplitContainer from '../docking/DockSplitContainer'
import { saveEditor } from '../lib/editorSaveRegistry'
import { ArrowsOutSimple, ArrowsInSimple, X, Lock, LockOpen } from '@phosphor-icons/react'
import { resolveTerminalPreset } from '../lib/terminalRegistry'
import { useSettingsStore } from '../stores/settingsStore'
import { PANEL_DEFINITIONS } from '../../shared/panels'

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
    <button
      data-grab-button
      title={title}
      onClick={onClick}
      className="flex items-center justify-center w-[18px] h-[18px] rounded text-secondary hover:text-primary hover:bg-hover"
      style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: baseColor }}
    >
      {children}
    </button>
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
  zoomLevel,
  dockStoreApi,
  renderPanel,
  title: _title = 'Panel',
}) => {
  ensureKeyframes()

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

  // Wrap node-drag with the tab-vs-window routing. The tab bar uses this for
  // both empty-area mousedown (panelId undefined → whole node drag) and
  // individual tab mousedown (panelId set → detach that tab when the mini-dock
  // has multiple panels, else whole-node drag).
  const handleHeaderMouseDown = useCallback((e: React.MouseEvent, panelId?: string) => {
    if (panelId) {
      const total = countPanels(dockStoreApi.getState().zones.center.layout)
      if (total > 1) {
        handleTabDetachStart(e, panelId)
        return
      }
    }
    handleDragStart(e)
  }, [handleDragStart, handleTabDetachStart, dockStoreApi])

  const maximized = node ? checkMaximized(node) : false

  const { handleResizeStart } = useNodeResize(nodeId, primaryPanelType, zoomLevel, canvasApi)
  const { handleMouseDown, handleMouseMove } = useNodeResizeCursor(nodeRef, node, zoomLevel, handleResizeStart)
  const wsId = useAppStore((s) => s.selectedWorkspaceId)
  const currentWorkspace = useSelectedWorkspace()

  // Subscribe to custom themes and the default-theme setting so chrome tint
  // re-renders when either changes.
  const customThemes = useSettingsStore((s) => s.terminalCustomThemes)
  const defaultTerminalTheme = useSettingsStore((s) => s.defaultTerminalTheme)
  const chromeTint = useMemo(() => {
    if (primaryPanel?.type !== 'terminal') return null
    const preset = resolveTerminalPreset(primaryPanel.themePreset)
    if (!preset) return null
    return { background: preset.theme.background, accent: preset.accent }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [primaryPanel, customThemes, defaultTerminalTheme])

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

  const collectPanelIds = useCallback((n: DockLayoutNode | null): string[] => {
    if (!n) return []
    if (n.type === 'tabs') return [...n.panelIds]
    const out: string[] = []
    for (const child of n.children) out.push(...collectPanelIds(child))
    return out
  }, [])

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

  const { containerStyle, glowStyle } = useCanvasNodeStyle({
    node,
    isFocused,
    isSelected,
    activityState,
    zoomLevel,
    isAnimatingLayout,
    isHovered,
    chromeTint,
    isWholeNodeDragSource,
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
      onMouseMove={handleMouseMove}
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
              focusNode(nodeId)
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
    </>
  )
}

export default React.memo(CanvasNode, (prev, next) => {
  return (
    prev.nodeId === next.nodeId &&
    prev.isFocused === next.isFocused &&
    prev.zoomLevel === next.zoomLevel &&
    prev.activityState === next.activityState &&
    prev.dockStoreApi === next.dockStoreApi &&
    prev.renderPanel === next.renderPanel &&
    prev.title === next.title
  )
})
