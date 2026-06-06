// =============================================================================
// DockTabStack — tab bar + renders the active panel's component.
// Supports dock-aware drag initiation from tabs and drop zone registration.
// =============================================================================

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useDockStoreApi } from '../stores/DockStoreContext'
import { registerDropZone, useDragStore } from '../drag'
import type { DockTabStack as DockTabStackType, PanelState, PanelType } from '../../shared/types'
import { useAppStore } from '../stores/appStore'
import { Columns, Plus } from '@phosphor-icons/react'
import { DockTabBar } from './DockTabBar'
import { DockTabContextMenu, SPLIT_MENU_ITEMS } from './DockTabContextMenu'
import type { SplitMenuItem } from './DockTabContextMenu'
import { useDockTabActions, useAcceptsPanelType } from './useDockTabActions'
import { setActiveSurface } from '../lib/activeSurface'
import { useDockTabDrag } from './useDockTabDrag'
import { PANEL_DEFINITIONS } from '../../shared/panels'

// Human-readable labels for each panel type, used in tooltips and the split menu.
const PANEL_TYPE_LABELS: Record<PanelType, string> = Object.fromEntries(
  (Object.keys(PANEL_DEFINITIONS) as PanelType[]).map((t) => [t, PANEL_DEFINITIONS[t].label]),
) as Record<PanelType, string>

interface DockTabStackProps {
  stack: DockTabStackType
  zone: 'left' | 'right' | 'bottom' | 'center'
  renderPanel: (panelId: string) => React.ReactNode
  getPanelTitle: (panelId: string) => string
  onClosePanel?: (panelId: string) => void
  getPanel?: (panelId: string) => PanelState | undefined
  workspaceId?: string
  onPanelRemoved?: (panelId: string) => void
  onPanelRenamed?: (panelId: string, title: string) => void
  /** Panel types this stack will refuse from new-tab / split menus and from
   *  drag-and-drop. */
  excludePanelTypes?: PanelType[]
  /** Extra controls rendered to the right of the +/split buttons. */
  trailingControls?: React.ReactNode
  /** Mouse-down handler for the tab bar — fired both for the empty header
   *  area (no panelId) and for individual tab clicks (panelId set). */
  onTabBarMouseDown?: (e: React.MouseEvent, panelId?: string) => void
  /** When true, new panels skip global dock placement. */
  localOnly?: boolean
  /** When true, render a slimmer tab bar (used by canvas-node mini-docks). */
  compact?: boolean
  /** When true, this stack's drop-zone returns a null rect so it can't be
   *  hit-tested as a target. */
  dropDisabled?: boolean
}

export default function DockTabStack({ stack, zone: zoneProp, renderPanel, getPanelTitle, onClosePanel, getPanel: getPanelProp, workspaceId: workspaceIdProp, onPanelRemoved, onPanelRenamed, excludePanelTypes, trailingControls, onTabBarMouseDown, localOnly, compact, dropDisabled }: DockTabStackProps) {
  const dockStoreApi = useDockStoreApi()
  const stackRef = useRef<HTMLDivElement>(null)

  const isDragging = useDragStore((s) => s.isDragging)
  const target = useDragStore((s) => s.target)
  const dragSource = useDragStore((s) => s.source)

  // Memoise the accept predicate so the registered entry is stable across
  // renders (the registry compares by entry identity).
  const acceptsPanelType = useAcceptsPanelType(excludePanelTypes)

  // Register this tab stack as a drop zone.
  const dropDisabledRef = useRef(false)
  dropDisabledRef.current = !!dropDisabled
  useEffect(() => {
    return registerDropZone({
      id: `stack-${stack.id}`,
      zone: zoneProp,
      stackId: stack.id,
      getRect: () =>
        dropDisabledRef.current ? null : stackRef.current?.getBoundingClientRect() ?? null,
      dockStoreApi,
      acceptsPanelType,
    })
  }, [stack.id, zoneProp, dockStoreApi, acceptsPanelType])

  const activePanelId = stack.panelIds[stack.activeIndex]

  // Effective workspace for status lookups: explicit prop, else the selected
  // workspace (matches resolvePanel's fallback). Subscribed so a workspace
  // switch re-scopes the tab agent indicators.
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId)
  const effectiveWorkspaceId = workspaceIdProp ?? selectedWorkspaceId

  const resolvePanel = useCallback(
    (panelId: string): PanelState | undefined => {
      if (getPanelProp) return getPanelProp(panelId)
      const wsId = workspaceIdProp ?? useAppStore.getState().selectedWorkspaceId
      const ws = useAppStore.getState().workspaces.find((w) => w.id === wsId)
      return ws?.panels[panelId]
    },
    [getPanelProp, workspaceIdProp],
  )

  const activePanel = activePanelId ? resolvePanel(activePanelId) : undefined

  // Tab interaction actions (rename, click, context menus, add/split helpers).
  const actions = useDockTabActions({
    stack,
    zone: zoneProp,
    dockStoreApi,
    workspaceId: workspaceIdProp,
    getPanelProp,
    onClosePanel,
    onPanelRemoved,
    onPanelRenamed,
    excludePanelTypes,
    localOnly,
    activePanel,
  })

  // Main-dock tab drag (canvas-node mini-docks route through onTabBarMouseDown).
  const { handleTabMouseDown } = useDockTabDrag({
    stackId: stack.id,
    zone: zoneProp,
    dockStoreApi,
    getPanel: getPanelProp,
  })

  const excludeKey = (excludePanelTypes ?? []).join(',')
  const visibleSplitItems = useMemo<SplitMenuItem[]>(
    () => SPLIT_MENU_ITEMS.filter((m) => !excludePanelTypes?.includes(m.type)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [excludeKey],
  )

  const onEmptyContextMenu = useCallback(
    (e: React.MouseEvent) => {
      void actions.handleTabBarContextMenu(e, visibleSplitItems)
    },
    [actions, visibleSplitItems],
  )

  // --- Split button (with long-press menu) ---------------------------------
  const [splitMenuOpen, setSplitMenuOpen] = useState(false)
  const [splitMenuPos, setSplitMenuPos] = useState<{ top: number; right: number } | null>(null)
  const splitButtonRef = useRef<HTMLButtonElement>(null)
  const longPressTimer = useRef<number | null>(null)
  const longPressFired = useRef(false)
  const springLoadTimer = useRef<number | null>(null)

  useEffect(() => {
    return () => {
      if (springLoadTimer.current) {
        window.clearTimeout(springLoadTimer.current)
        springLoadTimer.current = null
      }
    }
  }, [])

  const handleSplitClick = useCallback(() => {
    if (longPressFired.current) {
      longPressFired.current = false
      return
    }
    if (!activePanel) return
    actions.splitWithType(activePanel.type)
  }, [activePanel, actions])

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

  useEffect(() => {
    if (!splitMenuOpen) return
    const onDown = () => setSplitMenuOpen(false)
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [splitMenuOpen])

  // Inline "new tab" placeholder when a dock-tab drop targets this stack.
  // The resolver already vetoes invalid self-drops (single-tab same-stack);
  // anything that arrives here as a dock-tab target is a real reorder/redock,
  // so we show the placeholder regardless of source identity.
  const showTabPlaceholder =
    isDragging &&
    target?.kind === 'dock-tab' &&
    target.stackId === stack.id

  // When the dragged tab originates from THIS stack, hide it from the strip
  // and slot the placeholder at its original index (clamped so a leading
  // drag still leaves the next tab in front of the placeholder).
  const selfTabDrag = useMemo(() => {
    if (!showTabPlaceholder) return null
    if (!dragSource || dragSource.origin.kind !== 'dock-tab') return null
    if (dragSource.origin.stackId !== stack.id) return null
    const idx = stack.panelIds.indexOf(dragSource.panelId)
    if (idx < 0) return null
    return { draggedPanelId: dragSource.panelId, originalIndex: idx }
  }, [showTabPlaceholder, dragSource, stack.id, stack.panelIds])

  return (
    <div
      ref={stackRef}
      className="flex flex-col h-full min-h-0 relative"
      // Mark this stack as the active surface on any pointer-down inside it (tab
      // bar OR content), so a panel-create shortcut lands here — even in a split
      // and even when the click didn't land on a focusable element. Capture phase
      // so a canvas docked in this stack can override on the bubble phase (see
      // activeSurface). `localOnly` mini-docks (canvas nodes) opt out.
      onPointerDownCapture={
        localOnly ? undefined : () => setActiveSurface({ kind: 'dock', zone: zoneProp, stackId: stack.id })
      }
    >
      {/* Tab bar — VS Code style: dark strip with active tab merging into the
          content area below via a top accent border. */}
      <div
        className={`dock-tab-bar flex items-stretch overflow-hidden ${compact ? 'min-h-[26px]' : 'min-h-[36px]'}`}
        style={{
          backgroundColor: 'var(--node-chrome-bg, var(--surface-1))',
          ...(onTabBarMouseDown ? { cursor: 'grab' } : null),
        }}
        onContextMenu={onEmptyContextMenu}
        onMouseDown={(e) => {
          if (e.target !== e.currentTarget) return
          onTabBarMouseDown?.(e)
        }}
      >
        <DockTabBar
          stack={stack}
          compact={compact}
          workspaceId={effectiveWorkspaceId}
          getPanel={resolvePanel}
          getPanelTitle={getPanelTitle}
          onClosePanel={onClosePanel}
          onTabClick={actions.handleTabClick}
          onTabMouseDown={(e, panelId) => {
            // In a canvas-node mini-dock (onTabBarMouseDown supplied by the
            // host) route tab mousedown through the SAME handler the empty
            // tab-bar uses, passing the panelId so the host can choose:
            // drag the whole node (single-tab) vs detach just this tab
            // (multi-tab).
            if (onTabBarMouseDown) {
              onTabBarMouseDown(e, panelId)
              return
            }
            handleTabMouseDown(e, panelId)
          }}
          onTabContextMenu={actions.handleTabContextMenu}
          renameId={actions.renameId}
          renameValue={actions.renameValue}
          renameInputRef={actions.renameInputRef}
          setRenameValue={actions.setRenameValue}
          setRenameId={actions.setRenameId}
          commitRename={actions.commitRename}
          beginRename={actions.beginRename}
          springLoadTimer={springLoadTimer}
          setActiveTab={actions.setActiveTab}
          onEmptyMouseDown={(e) => onTabBarMouseDown?.(e)}
          onEmptyContextMenu={onEmptyContextMenu}
          showTabPlaceholder={showTabPlaceholder}
          selfTabDrag={selfTabDrag}
          onTabBarMouseDown={onTabBarMouseDown}
        />

        {/* "+" tab — adds a new tab of the active panel's type into this stack. */}
        {activePanel && (
          <button
            className={`flex items-center justify-center self-center rounded text-secondary hover:text-primary hover:bg-hover cursor-pointer ${compact ? 'mx-0.5 my-0.5 w-[18px] h-[18px]' : 'mx-1 my-1 w-[22px] h-[22px]'}`}
            title={`New ${PANEL_TYPE_LABELS[activePanel.type] ?? 'Tab'}`}
            onClick={() => actions.addTabOfType(activePanel.type)}
          >
            <Plus size={compact ? 12 : 13} />
          </button>
        )}

        {/* Split button. Click splits; click-and-hold opens a type picker. */}
        {activePanelId && (
          <div className={`relative flex items-center self-center ${compact ? 'px-0.5' : 'px-1'}`}>
            <button
              ref={splitButtonRef}
              className={`flex items-center justify-center rounded text-secondary hover:text-primary hover:bg-hover cursor-pointer ${compact ? 'w-[18px] h-[18px]' : 'w-[22px] h-[22px]'}`}
              title="Split (hold to choose type)"
              onClick={handleSplitClick}
              onMouseDown={handleSplitMouseDown}
              onMouseUp={cancelLongPress}
              onMouseLeave={cancelLongPress}
            >
              <Columns size={compact ? 12 : 14} />
            </button>
            <DockTabContextMenu
              open={splitMenuOpen}
              position={splitMenuPos}
              items={visibleSplitItems}
              onPick={actions.splitWithType}
              onClose={() => setSplitMenuOpen(false)}
            />
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

    </div>
  )
}
