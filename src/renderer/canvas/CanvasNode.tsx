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
import { useCanvasStoreContext, useCanvasStoreApi, shallow } from '../stores/CanvasStoreContext'
import { useAppStore, useSelectedWorkspace } from '../stores/appStore'
import { useNodeDrag } from '../hooks/useNodeDrag'
import { useNodeResize, detectEdge, getCursorForEdge } from '../hooks/useNodeResize'
import type { DockStore } from '../stores/dockStore'
import { DockStoreProvider } from '../stores/DockStoreContext'
import { useDockDragStore } from '../hooks/useDockDrag'
import DockTabStack from '../docking/DockTabStack'
import DockSplitContainer from '../docking/DockSplitContainer'
import { saveEditor } from '../lib/editorSaveRegistry'
import { ArrowsOutSimple, ArrowsInSimple, X, Lock, LockOpen } from '@phosphor-icons/react'
import { resolveTerminalPreset } from '../lib/terminalRegistry'
import { useSettingsStore } from '../stores/settingsStore'

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

const SHADOW_UNFOCUSED = `0 20px 60px -12px rgba(0,0,0,0.35), 0 6px 16px -4px rgba(0,0,0,0.2)`
const SHADOW_HOVERED = `${SHADOW_UNFOCUSED}, 0 0 32px rgba(255,255,255,0.03)`
// The colored focus glow is rendered as a separate sibling layer behind all
// nodes (see `glowStyle` below) so it can't overlay neighbouring nodes when
// the focused node sits on top in z-order.
const FOCUS_GLOW = `0 0 100px 8px rgba(74,158,255,0.09), 0 0 40px rgba(74,158,255,0.07)`

function boxShadow(hovered: boolean): string {
  if (hovered) return SHADOW_HOVERED
  return SHADOW_UNFOCUSED
}

function activityOutline(activity: NodeActivityState | undefined): string {
  if (!activity) return 'none'
  switch (activity.type) {
    case 'commandFinished':
      return '2px solid var(--activity-green)'
    case 'agentWaitingForInput':
      return '2px solid var(--activity-orange)'
    default:
      return 'none'
  }
}

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
  // When a dock-aware drag is active, hide the unfocused dim overlay so the
  // mini-dock's drop-preview indicator (rendered inside the dock layout at a
  // lower stacking-context z-index) is visible. Without this, dropping a tab
  // onto an unfocused canvas panel shows no visual feedback.
  const isDockDragging = useDockDragStore((s) => s.isDragging)
  // True while this canvas node is the source of an active dock-drag — i.e.
  // the user has grabbed its (only) tab and is moving it as a dock ghost.
  // The node is faded out so it doesn't sit duplicated next to the ghost
  // during the drag; on drop it either reappears at the new location
  // (canvas reposition) or is removed (docked elsewhere).
  const isDockDragSource = useDockDragStore((s) => {
    if (!s.isDragging || s.dragSource?.type !== 'dock') return false
    return s.sourceDockStoreApi === dockStoreApi
  })

  const { handleDragStart, wasDragged } = useNodeDrag(nodeId, zoomLevel, canvasApi)

  // Alt-drag from a node's tab bar starts a "connect drag": the user is wiring
  // this node to another. We render a ghost dotted line that follows the cursor
  // and, on mouseup over another node, create a CanvasConnection between them.
  const handleConnectDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const startNodeId = nodeId

    // Ghost path uses a single full-screen SVG overlay appended to body.
    const overlay = document.createElement('div')
    overlay.style.cssText = 'position:fixed;left:0;top:0;right:0;bottom:0;pointer-events:none;z-index:100000;'
    overlay.innerHTML = `<svg width="100%" height="100%" style="position:absolute;inset:0"><path id="cate-connect-ghost" d="" stroke="#4a9eff" stroke-width="2" stroke-dasharray="6 6" fill="none"/></svg>`
    document.body.appendChild(overlay)
    const ghost = overlay.querySelector<SVGPathElement>('#cate-connect-ghost')!

    // Compute the start point in screen coords from the source node's center.
    const startNode = canvasApi.getState().nodes[startNodeId]
    const getStartScreen = () => {
      const n = canvasApi.getState().nodes[startNodeId]
      if (!n) return { x: e.clientX, y: e.clientY }
      const cx = n.origin.x + n.size.width / 2
      const cy = n.origin.y + n.size.height / 2
      return canvasApi.getState().canvasToView({ x: cx, y: cy })
    }

    const findNodeAt = (clientX: number, clientY: number): string | null => {
      // Hit-test against canvasStore nodes AND annotations (sticky notes are
      // first-class connection endpoints — Maestri parity). The caller's
      // addConnection accepts either kind by id.
      const view = { x: clientX, y: clientY }
      const cs = canvasApi.getState().viewToCanvas(view)
      const state = canvasApi.getState()
      for (const n of Object.values(state.nodes)) {
        if (n.id === startNodeId) continue
        if (cs.x >= n.origin.x && cs.x <= n.origin.x + n.size.width &&
            cs.y >= n.origin.y && cs.y <= n.origin.y + n.size.height) {
          return n.id
        }
      }
      for (const a of Object.values(state.annotations)) {
        if (a.id === startNodeId) continue
        if (cs.x >= a.origin.x && cs.x <= a.origin.x + a.size.width &&
            cs.y >= a.origin.y && cs.y <= a.origin.y + a.size.height) {
          return a.id
        }
      }
      return null
    }

    let hoverTargetId: string | null = null

    const onMove = (ev: MouseEvent) => {
      const sp = getStartScreen()
      ghost.setAttribute('d', `M ${sp.x} ${sp.y} L ${ev.clientX} ${ev.clientY}`)
      hoverTargetId = findNodeAt(ev.clientX, ev.clientY)
      ghost.setAttribute('stroke', hoverTargetId ? '#4a9eff' : '#7c8aa1')
    }

    const onUp = (ev: MouseEvent) => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      window.removeEventListener('keydown', onKey)
      overlay.remove()
      const target = hoverTargetId ?? findNodeAt(ev.clientX, ev.clientY)
      if (target) canvasApi.getState().addConnection(startNodeId, target)
    }

    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
        window.removeEventListener('keydown', onKey)
        overlay.remove()
      }
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    window.addEventListener('keydown', onKey)
    // Seed the ghost on the start node center.
    const sp = getStartScreen()
    ghost.setAttribute('d', `M ${sp.x} ${sp.y} L ${e.clientX} ${e.clientY}`)
    void startNode // suppress unused if branch above no-ops
  }, [nodeId, canvasApi])

  // Wrap node-drag with the alt-key check. The tab bar uses this — alt-down
  // routes to connect, plain click routes to the normal node-move drag.
  const handleHeaderMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.altKey) {
      handleConnectDragStart(e)
      return
    }
    handleDragStart(e)
  }, [handleConnectDragStart, handleDragStart])

  const maximized = node ? checkMaximized(node) : false

  // Read the dock layout from the per-node store reactively
  const layout = useStore(dockStoreApi, (s) => s.zones.center.layout)

  const currentWorkspace = useSelectedWorkspace()

  // Derive the primary panel for minimum-size constraints and chrome tinting
  // (uses the layout's first leaf panel).
  const primaryPanel = useMemo(() => {
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
    if (!pid) return null
    return currentWorkspace?.panels[pid] ?? null
  }, [layout, currentWorkspace])
  const primaryPanelType: PanelType = primaryPanel?.type ?? 'editor'

  const { handleResizeStart } = useNodeResize(nodeId, primaryPanelType, zoomLevel, canvasApi)
  const wsId = useAppStore((s) => s.selectedWorkspaceId)

  // Subscribe to custom themes and the default-theme setting so chrome tint
  // re-renders when either changes.
  const customThemes = useSettingsStore((s) => s.terminalCustomThemes)
  const defaultTerminalTheme = useSettingsStore((s) => s.defaultTerminalTheme)
  /** When the primary panel is a terminal with a preset (or the global
   *  default-theme setting points at one), derive the chrome background +
   *  accent so the whole node reflects the terminal's palette. */
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

  // Both lookups fall back to a fresh appStore read so a brief gap in the
  // selected-workspace subscription (e.g. mid-switch) doesn't make every tab
  // collapse to a generic "Panel" / editor-icon label.
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
      // Panel exists but its title was cleared (e.g. browser nav to a blank
      // page). Use the type label so the tab still reads as "Terminal" /
      // "Browser" instead of a meaningless "Panel".
      if (p?.type) {
        const labels: Record<PanelType, string> = {
          terminal: 'Terminal', browser: 'Browser', editor: 'Editor',
          git: 'Git', fileExplorer: 'File Explorer', projectList: 'Projects', canvas: 'Canvas',
        }
        return labels[p.type] ?? 'Panel'
      }
      return 'Panel'
    },
    [resolvePanel],
  )

  const getPanel = useCallback((panelId: string) => resolvePanel(panelId), [resolvePanel])

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

  // Spring-load: when ANY dock drag is active AND this node is maximized
  // (covering the canvas), un-maximize after a short delay so the user can
  // see the canvas underneath and target a drop point. Subscribes directly
  // to the drag store (not via React selectors) so the timer is scheduled
  // off React render cycles — re-renders of CanvasNode would otherwise tear
  // down the effect and reset the timer before it fires.
  const toggleMaximizeRef = useRef(handleToggleMaximize)
  toggleMaximizeRef.current = handleToggleMaximize
  const maximizedRef = useRef(maximized)
  maximizedRef.current = maximized
  useEffect(() => {
    let timerId: number | null = null
    const tryArm = () => {
      const s = useDockDragStore.getState()
      if (!s.isDragging || s.draggedPanelType === 'canvas') return
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
    const unsub = useDockDragStore.subscribe((s, prev) => {
      if (s.isDragging && !prev.isDragging) tryArm()
      else if (!s.isDragging && prev.isDragging) cancel()
    })
    return () => { cancel(); unsub() }
  }, [])

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
          onTabBarMouseDown={isHeaderHost ? handleHeaderMouseDown : undefined}
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
    // Skip layout transitions while this node is the dock-drag source.
    // Spring-load un-maximize sets isAnimatingLayout=true and the resulting
    // left/top/width/height CSS transition makes the dimmed source visibly
    // "scale" alongside the dock ghost — confusing the user. Snapping
    // instantly to the un-maximized size keeps the source still while only
    // the ghost moves.
    const layoutTransition = isAnimatingLayout && !isDockDragSource
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
      border: `1.5px solid var(--border-subtle)`,
      boxShadow: boxShadow(isHovered),
      outline: activityOutline(activityState),
      outlineOffset: -1,
      animation: isPulsing ? 'pulseActivity 1s ease-in-out infinite alternate' : undefined,
      // When the primary panel is a themed terminal, paint the entire node
      // chrome with the terminal's background colour. The `--node-chrome-bg`
      // var is consumed by DockTabStack so the tab bar + tabs tint too.
      backgroundColor: chromeTint?.background ?? 'var(--node-bg-active)',
      ['--node-chrome-bg' as any]: chromeTint?.background ?? 'var(--surface-1)',
      // Active-tab background is a slightly lifted version of the chrome so
      // there's still visual separation from the bar around it.
      ['--node-chrome-active-bg' as any]: chromeTint
        ? `color-mix(in srgb, ${chromeTint.background} 86%, white 14%)`
        : 'var(--surface-3)',
      ['--node-chrome-accent' as any]: chromeTint?.accent ?? 'var(--focus-blue)',
      transition: baseTransition + layoutTransition,
      transform: isEntering ? 'scale(0.85)' : isExiting ? 'scale(0.9)' : 'scale(1)',
      // Hide the source entirely during a dock-drag. Showing it at 0.25
      // opacity left a visible outline that overlapped the ghost, and any
      // background re-render that touched the node's size/transform read as
      // it "scaling with movement" since the ghost moved with the cursor.
      // The ghost itself is the only thing the user should track during a
      // dock-drag; the source reappears either at the new location (canvas
      // reposition) or is removed (docked elsewhere).
      opacity: isEntering ? 0 : isExiting ? 0 : isDockDragSource ? 0 : 1,
      pointerEvents: isExiting || isDockDragSource ? 'none' : undefined,
      userSelect: 'none',
    }
  }, [node, isFocused, isSelected, activityState, zoomLevel, isAnimatingLayout, isHovered, chromeTint, isDockDragSource])

  // Colored focus/selection glow rendered as a sibling at a fixed low z-index
  // so it sits behind every node — its halo can't bleed over neighbouring
  // nodes the way a box-shadow on the focused node itself would.
  const glowStyle = useMemo<React.CSSProperties | null>(() => {
    if (!node) return null
    if (!(isFocused || isSelected)) return null
    const isEntering = node.animationState === 'entering'
    const isExiting = node.animationState === 'exiting'
    const layoutTransition = isAnimatingLayout && !isDockDragSource
      ? 'left 250ms cubic-bezier(0.16, 1, 0.3, 1), top 250ms cubic-bezier(0.16, 1, 0.3, 1), width 250ms cubic-bezier(0.16, 1, 0.3, 1), height 250ms cubic-bezier(0.16, 1, 0.3, 1), '
      : ''
    return {
      position: 'absolute',
      left: node.origin.x,
      top: node.origin.y,
      width: node.size.width,
      height: node.size.height,
      zIndex: 999,
      borderRadius: CORNER_RADIUS,
      boxShadow: FOCUS_GLOW,
      pointerEvents: 'none',
      transform: isEntering ? 'scale(0.85)' : isExiting ? 'scale(0.9)' : 'scale(1)',
      opacity: isEntering || isExiting || isDockDragSource ? 0 : 1,
      transition: `${layoutTransition}transform 200ms cubic-bezier(0.34, 1.56, 0.64, 1), opacity 150ms ease-out`,
    }
  }, [node, isFocused, isSelected, isAnimatingLayout, isDockDragSource])

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
            // When this node uses its dock tab bar as the header (isHeaderHost),
            // leave the tab strip uncovered so a mousedown on a tab can start
            // a dock-drag in a single gesture instead of requiring a prior
            // click-to-focus. Tab strip height matches DockTabStack's compact
            // mode (min-h-[26px]).
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
            // Capture-phase: any mousedown inside the (now uncovered) dock tab
            // bar should focus this canvas node before the tab handler runs, so
            // a single click+hold on a tab both focuses the node and starts the
            // dock drag in one gesture.
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
