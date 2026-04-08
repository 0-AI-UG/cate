// =============================================================================
// DockTabStack — tab bar + renders the active panel's component.
// Supports dock-aware drag initiation from tabs and drop zone registration.
// =============================================================================

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useDockStoreContext, useDockStoreApi } from '../stores/DockStoreContext'
import { useDockDragStore, registerDropZone, hitTestDropTarget, hitTestDropTargetWithStore } from '../hooks/useDockDrag'
import { executeDrop } from './dropExecution'
import { createTransferSnapshot } from '../lib/panelTransfer'
import { terminalRegistry } from '../lib/terminalRegistry'
import type { DockTabStack as DockTabStackType, PanelState, PanelType } from '../../shared/types'
import { useAppStore } from '../stores/appStore'
import { X, Columns, Plus, Terminal as TerminalIcon, Globe, FileText, GitBranch, TreeStructure, SquaresFour, List } from '@phosphor-icons/react'
import DropZoneOverlay from './DropZoneOverlay'
import { canvasDropZoneHovered } from './CanvasDropZone'

// Human-readable labels for each panel type, used in tooltips and the split menu.
const PANEL_TYPE_LABELS: Record<PanelType, string> = {
  editor: 'Editor',
  terminal: 'Terminal',
  browser: 'Browser',
  git: 'Git',
  fileExplorer: 'File Explorer',
  projectList: 'Projects',
  canvas: 'Canvas',
}

// Items shown in the long-press split menu (order = display order).
type SplitMenuItem = { type: PanelType; label: string; Icon: React.ComponentType<any> }
const SPLIT_MENU_ITEMS: SplitMenuItem[] = [
  { type: 'editor', label: 'Editor', Icon: FileText },
  { type: 'terminal', label: 'Terminal', Icon: TerminalIcon },
  { type: 'browser', label: 'Browser', Icon: Globe },
  { type: 'fileExplorer', label: 'File Explorer', Icon: TreeStructure },
  { type: 'git', label: 'Git', Icon: GitBranch },
  { type: 'canvas', label: 'Canvas', Icon: SquaresFour },
  { type: 'projectList', label: 'Projects', Icon: List },
]

interface DockTabStackProps {
  stack: DockTabStackType
  zone: 'left' | 'right' | 'bottom' | 'center'
  renderPanel: (panelId: string) => React.ReactNode
  getPanelTitle: (panelId: string) => string
  onClosePanel?: (panelId: string) => void
  getPanel?: (panelId: string) => PanelState | undefined
  workspaceId?: string
  onPanelRemoved?: (panelId: string) => void
  /** Panel types this stack will refuse from new-tab / split menus and from
   *  drag-and-drop. Used by canvas-node mini-docks to keep canvas panels out
   *  (a canvas inside a canvas isn't supported). */
  excludePanelTypes?: PanelType[]
  /** Extra controls rendered to the right of the +/split buttons. Canvas
   *  nodes inject lock/maximize/close here so the node has only one bar. */
  trailingControls?: React.ReactNode
  /** Mouse-down handler for empty area of the tab bar — lets the host
   *  intercept clicks to start node-level drag (canvas nodes use this to
   *  drag the whole node from the empty tab-bar area). */
  onTabBarMouseDown?: (e: React.MouseEvent) => void
  /** When true, new panels created via "+" / split menus skip global dock
   *  placement and are added straight to the local store. Used by canvas-node
   *  mini-docks to keep the panel out of the main dock zones. */
  localOnly?: boolean
  /** When true, render a slimmer tab bar (used by canvas-node mini-docks). */
  compact?: boolean
}

export default function DockTabStack({ stack, zone: zoneProp, renderPanel, getPanelTitle, onClosePanel, getPanel: getPanelProp, workspaceId: workspaceIdProp, onPanelRemoved, excludePanelTypes, trailingControls, onTabBarMouseDown, localOnly, compact }: DockTabStackProps) {
  const setActiveTab = useDockStoreContext((s) => s.setActiveTab)
  const dockStoreApi = useDockStoreApi()
  const stackRef = useRef<HTMLDivElement>(null)
  const dragAbortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    return () => { dragAbortRef.current?.abort() }
  }, [])

  const isDragging = useDockDragStore((s) => s.isDragging)
  const activeDropTarget = useDockDragStore((s) => s.activeDropTarget)
  const dragSource = useDockDragStore((s) => s.dragSource)

  // Memoise the accept predicate so the registered entry is stable across
  // renders (the registry compares by entry identity).
  const excludeKey = (excludePanelTypes ?? []).join(',')
  const acceptsPanelType = useMemo(() => {
    if (!excludePanelTypes || excludePanelTypes.length === 0) return undefined
    const set = new Set<PanelType>(excludePanelTypes)
    return (type: PanelType) => !set.has(type)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [excludeKey])

  // Register this tab stack as a drop zone, attaching the owning DockStore so
  // cross-store drag-and-drop (e.g. between two canvas-node mini-docks) can
  // route the drop to the correct store.
  useEffect(() => {
    return registerDropZone({
      id: `stack-${stack.id}`,
      zone: zoneProp,
      stackId: stack.id,
      getRect: () => stackRef.current?.getBoundingClientRect() ?? null,
      dockStoreApi,
      acceptsPanelType,
    })
  }, [stack.id, zoneProp, dockStoreApi, acceptsPanelType])

  // ---------------------------------------------------------------------------
  // Native context menus (tab + tab bar)
  // ---------------------------------------------------------------------------

  const getPanelLocal = useCallback(
    (panelId: string): PanelState | undefined => {
      if (getPanelProp) return getPanelProp(panelId)
      const wsId = useAppStore.getState().selectedWorkspaceId
      const ws = useAppStore.getState().workspaces.find((w) => w.id === wsId)
      return ws?.panels[panelId]
    },
    [getPanelProp],
  )

  const moveTabToNewWindow = useCallback(
    async (panelId: string) => {
      const panel = getPanelLocal(panelId)
      if (!panel) return
      const snapshot = createTransferSnapshot(
        panel,
        { type: 'dock', zone: zoneProp, stackId: stack.id },
        { origin: { x: 100, y: 100 }, size: { width: 800, height: 600 } },
      )
      dockStoreApi.getState().undockPanel(panelId)
      if (panel.type === 'terminal') terminalRegistry.release(panelId)
      onPanelRemoved?.(panelId)
      const wsId = workspaceIdProp ?? useAppStore.getState().selectedWorkspaceId
      await window.electronAPI.dragDetach(snapshot, wsId)
    },
    [getPanelLocal, zoneProp, stack.id, dockStoreApi, onPanelRemoved, workspaceIdProp],
  )

  const handleTabContextMenu = useCallback(
    async (e: React.MouseEvent, panelId: string) => {
      e.preventDefault()
      e.stopPropagation()
      if (!window.electronAPI) return
      const idx = stack.panelIds.indexOf(panelId)
      const hasOthers = stack.panelIds.length > 1
      const hasRight = idx >= 0 && idx < stack.panelIds.length - 1
      const id = await window.electronAPI.showContextMenu([
        { id: 'close', label: 'Close', accelerator: 'Cmd+W' },
        { id: 'close-others', label: 'Close Others', enabled: hasOthers },
        { id: 'close-right', label: 'Close to the Right', enabled: hasRight },
        { id: 'close-all', label: 'Close All', accelerator: 'Cmd+K Cmd+W' },
        { type: 'separator' },
        { id: 'split-right', label: 'Split Right' },
        { id: 'move-window', label: 'Move into New Window' },
      ])
      switch (id) {
        case 'close':
          onClosePanel?.(panelId)
          break
        case 'close-others': {
          const others = stack.panelIds.filter((p) => p !== panelId)
          others.forEach((p) => onClosePanel?.(p))
          break
        }
        case 'close-right': {
          const toClose = stack.panelIds.slice(idx + 1)
          toClose.forEach((p) => onClosePanel?.(p))
          break
        }
        case 'close-all':
          stack.panelIds.slice().forEach((p) => onClosePanel?.(p))
          break
        case 'split-right': {
          const panel = getPanelLocal(panelId)
          if (panel) splitWithType(panel.type)
          break
        }
        case 'move-window':
          moveTabToNewWindow(panelId)
          break
      }
    },
    [stack.panelIds, onClosePanel, getPanelLocal, moveTabToNewWindow],
  )

  const visibleSplitItems = useMemo<SplitMenuItem[]>(
    () => SPLIT_MENU_ITEMS.filter((m) => !excludePanelTypes?.includes(m.type)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [excludeKey],
  )

  const handleTabBarContextMenu = useCallback(
    async (e: React.MouseEvent) => {
      // Only fire on the empty area of the tab bar, not on tabs themselves.
      if (e.target !== e.currentTarget) return
      e.preventDefault()
      if (!window.electronAPI) return
      const id = await window.electronAPI.showContextMenu([
        {
          label: 'New Tab',
          submenu: visibleSplitItems.map((m) => ({ id: `new:${m.type}`, label: m.label })),
        },
        { type: 'separator' },
        {
          label: 'Split With',
          submenu: visibleSplitItems.map((m) => ({ id: `split:${m.type}`, label: m.label })),
        },
        { type: 'separator' },
        { id: 'close-all', label: 'Close All', enabled: stack.panelIds.length > 0 },
      ])
      if (!id) return
      if (id === 'close-all') {
        stack.panelIds.slice().forEach((p) => onClosePanel?.(p))
        return
      }
      const [kind, type] = id.split(':') as [string, PanelType]
      if (kind === 'new') addTabOfType(type)
      else if (kind === 'split') splitWithType(type)
    },
    // splitWithType / addTabOfType are defined later but referenced via closure;
    // they're stable callbacks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [stack.panelIds, onClosePanel],
  )

  const handleTabClick = useCallback(
    (index: number) => {
      setActiveTab(stack.id, index)
    },
    [stack.id, setActiveTab],
  )

  // Drag initiation from tab
  const handleTabMouseDown = useCallback(
    (e: React.MouseEvent, panelId: string) => {
      if (e.button !== 0) return
      const startX = e.clientX
      const startY = e.clientY
      let dragStarted = false
      let cwDragSnapshot: import('../../shared/types').PanelTransferSnapshot | null = null

      let panel: PanelState | undefined
      if (getPanelProp) {
        panel = getPanelProp(panelId)
      } else {
        const wsId = useAppStore.getState().selectedWorkspaceId
        const ws = useAppStore.getState().workspaces.find(w => w.id === wsId)
        panel = ws?.panels[panelId]
      }
      if (!panel) return

      const sourceZone = zoneProp

      const handleMove = (ev: MouseEvent) => {
        if (!dragStarted) {
          if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 4) return
          dragStarted = true
          document.body.classList.add('canvas-interacting')
          useDockDragStore.getState().startDrag(
            panelId,
            panel.type,
            panel.title,
            { type: 'dock', zone: sourceZone, stackId: stack.id },
            dockStoreApi,
          )
        }

        const dockDrag = useDockDragStore.getState()
        dockDrag.updateCursor({ x: ev.clientX, y: ev.clientY })

        // Check if cursor is outside the window BEFORE hit testing — otherwise
        // the cursor can pass through a sibling panel's drop zone on the way out,
        // causing a local drop instead of a detach.
        // In fullscreen, treat the cursor as always inside so the drag never
        // transitions to cross-window detach mode (which would open a new
        // BrowserWindow in a separate Space and appear as a black page).
        const fullscreenLocked = window.electronAPI?.isMainWindowFullscreen?.() ?? false
        const outsideWindow = fullscreenLocked
          ? false
          : ev.clientX <= 0 || ev.clientY <= 0 || ev.clientX >= window.innerWidth || ev.clientY >= window.innerHeight
        if (!outsideWindow) {
          // Skip hit-testing when the CanvasDropZone overlay is hovered —
          // it handles the drop itself via onPointerUp.
          if (!canvasDropZoneHovered) {
            const target = hitTestDropTarget(ev.clientX, ev.clientY)
            dockDrag.setDropTarget(target)
          }
        } else {
          dockDrag.setDropTarget(null)
        }
        if (outsideWindow && !cwDragSnapshot) {
          const snapshot = createTransferSnapshot(
            panel,
            { type: 'dock', zone: sourceZone, stackId: stack.id },
            { origin: { x: ev.screenX, y: ev.screenY }, size: { width: 700, height: 500 } },
          )
          cwDragSnapshot = snapshot
          window.electronAPI.crossWindowDragStart(snapshot, { x: ev.screenX, y: ev.screenY })
        } else if (!outsideWindow && cwDragSnapshot) {
          // Cursor re-entered this window — cancel cross-window drag
          cwDragSnapshot = null
          window.electronAPI.crossWindowDragCancel()
        }
      }

      const cleanup = () => {
        dragAbortRef.current?.abort()
        dragAbortRef.current = null
        document.body.classList.remove('canvas-interacting')
      }

      const handleUp = (ev: MouseEvent) => {
        cleanup()

        if (dragStarted) {
          const dockDrag = useDockDragStore.getState()
          // CanvasDropZone already handled this drop — skip our own logic.
          if (dockDrag.canvasDropConsumed) {
            useDockDragStore.getState().endDrag()
            return
          }
          const target = dockDrag.activeDropTarget

          if (target && dockDrag.draggedPanelId) {
            // Drop within this window — cancel any cross-window drag
            if (cwDragSnapshot) {
              cwDragSnapshot = null
              window.electronAPI.crossWindowDragCancel()
            }
            // Re-resolve hit so we know which store owns the drop target.
            // This lets a tab dragged out of a canvas-node mini-dock land
            // inside a different mini-dock or the main dock.
            const hit = hitTestDropTargetWithStore(ev.clientX, ev.clientY)
            const targetStore = hit?.dockStoreApi ?? dockStoreApi
            executeDrop(
              dockDrag.draggedPanelId,
              { type: 'dock', zone: sourceZone, stackId: stack.id },
              hit?.target ?? target,
              undefined,
              targetStore,
              dockStoreApi,
            )
          } else if (
            dockDrag.draggedPanelId &&
            !(window.electronAPI?.isMainWindowFullscreen?.() ?? false) &&
            (ev.clientX <= 0 || ev.clientY <= 0 || ev.clientX >= window.innerWidth || ev.clientY >= window.innerHeight)
          ) {
            // Cursor outside window — try cross-window drop, fall back to detach
            const draggedId = dockDrag.draggedPanelId
            const cwSnapshot = cwDragSnapshot
            cwDragSnapshot = null

            if (cwSnapshot) {
              window.electronAPI.crossWindowDragResolve().then(async ({ claimed }) => {
                if (claimed) {
                  // Target window accepted — remove panel from this dock
                  dockStoreApi.getState().undockPanel(draggedId)
                  if (panel?.type === 'terminal') terminalRegistry.release(draggedId)
                  onPanelRemoved?.(draggedId)
                } else {
                  // No target — try to detach into a new dock window. Only
                  // undock from this store if the main process accepted
                  // (it returns null when the parent is fullscreen).
                  const wsId = workspaceIdProp ?? useAppStore.getState().selectedWorkspaceId
                  const winId = await window.electronAPI.dragDetach(cwSnapshot, wsId)
                  if (winId != null) {
                    dockStoreApi.getState().undockPanel(draggedId)
                    if (panel?.type === 'terminal') terminalRegistry.release(draggedId)
                    onPanelRemoved?.(draggedId)
                  }
                }
              })
            } else if (panel) {
              // No cross-window drag was active — direct detach
              const snapshot = createTransferSnapshot(
                panel,
                { type: 'dock', zone: sourceZone, stackId: stack.id },
                { origin: { x: ev.screenX, y: ev.screenY }, size: { width: 700, height: 500 } },
              )
              const wsId = workspaceIdProp ?? useAppStore.getState().selectedWorkspaceId
              window.electronAPI.dragDetach(snapshot, wsId).then((winId) => {
                if (winId != null) {
                  dockStoreApi.getState().undockPanel(draggedId)
                  if (panel.type === 'terminal') terminalRegistry.release(draggedId)
                  onPanelRemoved?.(draggedId)
                }
              })
            }
          }
          useDockDragStore.getState().endDrag()
        }
      }

      // Cancel drag on window blur — OS won't deliver mouseup
      const handleBlur = () => {
        if (dragStarted) {
          cleanup()
          if (cwDragSnapshot) {
            cwDragSnapshot = null
            window.electronAPI.crossWindowDragCancel()
          }
          useDockDragStore.getState().endDrag()
        }
      }

      dragAbortRef.current?.abort()
      const controller = new AbortController()
      dragAbortRef.current = controller
      const { signal } = controller
      window.addEventListener('mousemove', handleMove, { signal })
      window.addEventListener('mouseup', handleUp, { signal })
      window.addEventListener('blur', handleBlur, { signal })
    },
    [stack.id, zoneProp, getPanelProp, workspaceIdProp, onPanelRemoved, dockStoreApi],
  )

  const activePanelId = stack.panelIds[stack.activeIndex]

  // Resolve active panel for the split-editor button. Only editors with a
  // filePath can be "split" (we open a second editor for the same file in a
  // new stack to the right). Other panel types and Untitled buffers don't
  // have a sensible duplication semantic, so the button stays hidden.
  const activePanel = activePanelId
    ? (getPanelProp
        ? getPanelProp(activePanelId)
        : (() => {
            const wsId = useAppStore.getState().selectedWorkspaceId
            const ws = useAppStore.getState().workspaces.find(w => w.id === wsId)
            return ws?.panels[activePanelId]
          })())
    : undefined
  // Long-press menu state for the split button.
  const [splitMenuOpen, setSplitMenuOpen] = useState(false)
  const [splitMenuPos, setSplitMenuPos] = useState<{ top: number; right: number } | null>(null)
  const splitButtonRef = useRef<HTMLButtonElement>(null)
  const longPressTimer = useRef<number | null>(null)
  const longPressFired = useRef(false)
  const springLoadTimer = useRef<number | null>(null)

  // Cancel spring-load timer when the drag ends so it doesn't fire late.
  useEffect(() => {
    return () => {
      if (springLoadTimer.current) {
        window.clearTimeout(springLoadTimer.current)
        springLoadTimer.current = null
      }
    }
  }, [])

  // Create a new panel of the given type into this zone (will be placed in the
  // zone's first stack by appStore; caller relocates it as needed). Returns the
  // new panel id, or null on failure.
  // When `localOnly` is set, skip global dock placement entirely so the new
  // panel exists in workspace.panels but is owned by the local DockStore only.
  const createPanelOfType = useCallback(
    (type: PanelType): string | null => {
      const wsId = workspaceIdProp ?? useAppStore.getState().selectedWorkspaceId
      const placement: import('../stores/appStore').PanelPlacement = localOnly
        ? { target: 'none' }
        : { target: 'dock', zone: zoneProp }
      const app = useAppStore.getState()
      switch (type) {
        case 'editor': {
          // Duplicate the active editor's file when possible, otherwise untitled.
          const filePath =
            activePanel?.type === 'editor' && !activePanel.diffMode ? activePanel.filePath : undefined
          return app.createEditor(wsId, filePath, undefined, placement) || null
        }
        case 'terminal':
          return app.createTerminal(wsId, undefined, undefined, placement) || null
        case 'browser':
          return app.createBrowser(wsId, undefined, undefined, placement) || null
        case 'git':
          return app.createGit(wsId, undefined, placement) || null
        case 'fileExplorer':
          return app.createFileExplorer(wsId, undefined, placement) || null
        case 'projectList':
          return app.createProjectList(wsId, undefined, placement) || null
        case 'canvas':
          return app.createCanvas(wsId, undefined, placement) || null
        default:
          return null
      }
    },
    [activePanel, workspaceIdProp, zoneProp, localOnly],
  )

  // Add a new tab of the given type into THIS stack (used by the "+" button).
  const addTabOfType = useCallback(
    (type: PanelType) => {
      const newId = createPanelOfType(type)
      if (!newId) return
      // createX placed it in this zone's first stack — move into our stack.
      dockStoreApi.getState().dockPanel(newId, zoneProp, {
        type: 'tab',
        stackId: stack.id,
      })
    },
    [createPanelOfType, dockStoreApi, zoneProp, stack.id],
  )

  // Split this stack to the right with a new panel of the given type.
  const splitWithType = useCallback(
    (type: PanelType) => {
      const newId = createPanelOfType(type)
      if (!newId) return
      dockStoreApi.getState().dockPanel(newId, zoneProp, {
        type: 'split',
        stackId: stack.id,
        edge: 'right',
      })
    },
    [createPanelOfType, dockStoreApi, zoneProp, stack.id],
  )

  const handleSplitClick = useCallback(() => {
    if (longPressFired.current) {
      // The long-press already opened the menu; ignore the click that follows.
      longPressFired.current = false
      return
    }
    if (!activePanel) return
    splitWithType(activePanel.type)
  }, [activePanel, splitWithType])

  const handleSplitMouseDown = useCallback(() => {
    longPressFired.current = false
    if (longPressTimer.current) window.clearTimeout(longPressTimer.current)
    longPressTimer.current = window.setTimeout(() => {
      longPressFired.current = true
      const rect = splitButtonRef.current?.getBoundingClientRect()
      if (rect) {
        setSplitMenuPos({ top: rect.bottom + 4, right: window.innerWidth - rect.right })
      }
      setSplitMenuOpen(true)
    }, 350)
  }, [])

  const cancelLongPress = useCallback(() => {
    if (longPressTimer.current) {
      window.clearTimeout(longPressTimer.current)
      longPressTimer.current = null
    }
  }, [])

  // Close the split menu on outside click.
  useEffect(() => {
    if (!splitMenuOpen) return
    const onDown = () => setSplitMenuOpen(false)
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [splitMenuOpen])

  // Check if this stack is the active drop target, but suppress indicators
  // when dragging a panel over the stack it originated from (self-drop is a no-op)
  const isSelfDrop =
    dragSource?.type === 'dock' && dragSource.stackId === stack.id
  const isOver =
    isDragging &&
    !isSelfDrop &&
    activeDropTarget != null &&
    (activeDropTarget.type === 'tab' || activeDropTarget.type === 'split') &&
    'stackId' in activeDropTarget &&
    activeDropTarget.stackId === stack.id

  return (
    <div ref={stackRef} className="flex flex-col h-full min-h-0 relative">
      {/* Tab bar — VS Code style: dark strip with active tab merging into the
          content area below via a top accent border. */}
      <div
        className={`dock-tab-bar flex items-stretch bg-surface-1 overflow-x-auto ${compact ? 'min-h-[24px]' : 'min-h-[35px]'}`}
        onContextMenu={handleTabBarContextMenu}
        onMouseDown={(e) => {
          // Empty area of the tab bar — host (e.g. canvas node) may want to
          // start a node-level drag here. Tabs/buttons stop propagation themselves.
          if (e.target !== e.currentTarget) return
          onTabBarMouseDown?.(e)
        }}
      >
        <div
          className="flex items-stretch flex-1 min-w-0"
          onContextMenu={handleTabBarContextMenu}
          onMouseDown={(e) => {
            if (e.target !== e.currentTarget) return
            onTabBarMouseDown?.(e)
          }}
        >
          {stack.panelIds.map((panelId, i) => {
            const isActive = i === stack.activeIndex
            return (
              <div
                key={panelId}
                className={`
                  group relative flex items-center gap-1.5 whitespace-nowrap
                  cursor-grab select-none
                  ${compact ? 'pl-2 pr-1.5 text-[11px]' : 'pl-3 pr-2 text-xs'}
                  ${isActive
                    ? 'bg-surface-3 text-primary'
                    : 'bg-surface-1 text-secondary hover:text-primary hover:bg-surface-2'
                  }
                `}
                onClick={() => handleTabClick(i)}
                onMouseDown={(e) => handleTabMouseDown(e, panelId)}
                onContextMenu={(e) => handleTabContextMenu(e, panelId)}
                onPointerEnter={() => {
                  // Spring-loaded tab: while a drag is in progress, hovering
                  // a non-active tab for 600ms switches to it. Lets the user
                  // drag a panel onto the "Canvas" tab and wait for the
                  // canvas to spring open before placing the node on it.
                  if (isActive) return
                  if (!useDockDragStore.getState().isDragging) return
                  if (springLoadTimer.current) window.clearTimeout(springLoadTimer.current)
                  springLoadTimer.current = window.setTimeout(() => {
                    setActiveTab(stack.id, i)
                  }, 600)
                }}
                onPointerLeave={() => {
                  if (springLoadTimer.current) {
                    window.clearTimeout(springLoadTimer.current)
                    springLoadTimer.current = null
                  }
                }}
                style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
              >
                <span className="truncate max-w-[160px]">{getPanelTitle(panelId)}</span>
                {onClosePanel && (
                  <span
                    className={`p-0.5 rounded-sm hover:bg-hover ${
                      isActive ? 'opacity-80' : 'opacity-0 group-hover:opacity-70'
                    }`}
                    onClick={(e) => {
                      e.stopPropagation()
                      onClosePanel(panelId)
                    }}
                  >
                    <X size={compact ? 12 : 11} />
                  </span>
                )}
              </div>
            )
          })}
          {/* Draggable spacer that fills the rest of the row. In a detached
              dock window this is the macOS title-bar drag region. In a
              canvas-node mini-dock (onTabBarMouseDown set) it's instead a
              mouse-event handle that initiates a node drag. */}
          <div
            className="flex-1 min-w-[20px] self-stretch"
            style={
              onTabBarMouseDown
                ? undefined
                : ({ WebkitAppRegion: 'drag' } as React.CSSProperties)
            }
            onMouseDown={onTabBarMouseDown}
            onContextMenu={handleTabBarContextMenu}
          />
        </div>

        {/* "+" tab — adds a new tab of the active panel's type into this stack. */}
        {activePanel && (
          <button
            className={`flex items-center justify-center self-center rounded text-secondary hover:text-primary hover:bg-hover ${compact ? 'mx-0.5 my-0.5 w-[18px] h-[18px]' : 'mx-1 my-1 w-[22px] h-[22px]'}`}
            title={`New ${PANEL_TYPE_LABELS[activePanel.type] ?? 'Tab'}`}
            onClick={() => addTabOfType(activePanel.type)}
          >
            <Plus size={compact ? 12 : 13} />
          </button>
        )}

        {/* Right-side action bar — split button. Click splits the current
            tab (same type). Click-and-hold opens a type picker. */}
        {activePanelId && (
          <div className={`relative flex items-center self-center ${compact ? 'px-0.5' : 'px-1'}`}>
            <button
              ref={splitButtonRef}
              className={`flex items-center justify-center rounded text-secondary hover:text-primary hover:bg-hover ${compact ? 'w-[18px] h-[18px]' : 'w-[22px] h-[22px]'}`}
              title="Split (hold to choose type)"
              onClick={handleSplitClick}
              onMouseDown={handleSplitMouseDown}
              onMouseUp={cancelLongPress}
              onMouseLeave={cancelLongPress}
            >
              <Columns size={compact ? 12 : 14} />
            </button>
            {splitMenuOpen && splitMenuPos && createPortal(
              <div
                className="fixed z-[1000] min-w-[170px] rounded-md border border-subtle bg-surface-3 shadow-xl py-1 text-xs"
                style={{ top: splitMenuPos.top, right: splitMenuPos.right }}
                onMouseDown={(e) => e.stopPropagation()}
              >
                {visibleSplitItems.map(({ type, label, Icon }) => (
                  <button
                    key={type}
                    className="flex items-center gap-2 w-full px-3 py-1.5 text-secondary hover:bg-surface-4 hover:text-primary"
                    onClick={() => {
                      setSplitMenuOpen(false)
                      splitWithType(type)
                    }}
                  >
                    <Icon size={13} className="text-muted" />
                    <span>Split with {label}</span>
                  </button>
                ))}
              </div>,
              document.body,
            )}
          </div>
        )}

        {/* Host-injected trailing controls (e.g. canvas-node lock/maximize/close) */}
        {trailingControls && (
          <div
            className="flex items-center self-center pr-1 gap-0.5"
            onMouseDown={(e) => e.stopPropagation()}
          >
            {trailingControls}
          </div>
        )}
      </div>

      {/* Active panel content */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {activePanelId ? renderPanel(activePanelId) : (
          <div className="flex items-center justify-center h-full text-muted text-sm">
            No panel
          </div>
        )}
      </div>

      {/* Drop zone overlay */}
      <DropZoneOverlay activeTarget={activeDropTarget} isOver={isOver} />
    </div>
  )
}

