// =============================================================================
// DockTabStack — tab bar + renders the active panel's component.
// Supports dock-aware drag initiation from tabs and drop zone registration.
// =============================================================================

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useDockStoreContext, useDockStoreApi } from '../stores/DockStoreContext'
import { registerDropZone, useDragStore } from '../drag'
import type { DockTabStack as DockTabStackType, PanelState, PanelType } from '../../shared/types'
import { useAppStore } from '../stores/appStore'
import { PanelChromeProvider, type PanelChromeApi } from '../panels/panelChrome'
import { Columns2 as Columns, Maximize2, Minimize2 } from 'lucide-react'
import { DockTabBar } from './DockTabBar'
import { WorktreePill } from '../canvas/WorktreePill'
import { AgentChangesPill } from '../canvas/AgentChangesPill'
import { SPLIT_MENU_ITEMS } from './DockTabContextMenu'
import type { SplitMenuItem } from './DockTabContextMenu'
import { useDockTabActions, useAcceptsPanelType } from './useDockTabActions'
import { setActivePanel } from '../lib/activePanel'
import { NewTabButton } from './NewTabButton'
import SurfacePicker from '../panels/SurfacePicker'
import { canSplitPane, layoutMinimum } from './splitSizing'
import { Tooltip } from '../ui/Tooltip'
import { useDockTabDrag } from './useDockTabDrag'
import { keepsMountedWhenTabHidden } from '../../shared/panels'


interface DockTabStackProps {
  stack: DockTabStackType
  zone: 'left' | 'right' | 'bottom' | 'center'
  renderPanel: (panelId: string) => React.ReactNode
  getPanelTitle: (panelId: string) => string
  onClosePanel?: (panelId: string) => void
  onClosePanels?: (panelIds: string[]) => Promise<boolean>
  getPanel?: (panelId: string) => PanelState | undefined
  workspaceId?: string
  onPanelRemoved?: (panelId: string) => void
  onPanelRenamed?: (panelId: string, title: string) => void
  /** Panel types this stack will refuse from new-tab / split menus and from
   *  drag-and-drop. */
  excludePanelTypes?: PanelType[]
  /** Extra controls rendered to the right of the +/split buttons. */
  trailingControls?: React.ReactNode
  newTabControl?: React.ReactNode
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

export default function DockTabStack({ stack, zone: zoneProp, renderPanel, getPanelTitle, onClosePanel, onClosePanels, getPanel: getPanelProp, workspaceId: workspaceIdProp, onPanelRemoved, onPanelRenamed, excludePanelTypes, trailingControls, newTabControl, onTabBarMouseDown, localOnly, compact, dropDisabled }: DockTabStackProps) {
  const dockStoreApi = useDockStoreApi()
  const canMaximize = useDockStoreContext((s) => Object.values(s.zones).some((zone) =>
    zone.visible && zone.layout && (zone.layout.type === 'split' || zone.layout.id !== stack.id),
  ))
  const maximized = useDockStoreContext((s) => s.maximizedStackId === stack.id)
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
      getElement: () => stackRef.current,
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

  // Panel records can settle after the dock layout, including while the shell
  // is hidden by Usage or Settings. Keep chrome and icons subscribed to them.
  const workspacePanels = useAppStore((s) =>
    s.workspaces.find((workspace) => workspace.id === effectiveWorkspaceId)?.panels,
  )
  const resolvePanel = useCallback(
    (panelId: string): PanelState | undefined => getPanelProp
      ? getPanelProp(panelId)
      : workspacePanels?.[panelId],
    [getPanelProp, workspacePanels],
  )

  const activePanel = activePanelId ? resolvePanel(activePanelId) : undefined

  const [splitAllowed, setSplitAllowed] = useState(false)
  const canSplit = useCallback(() => {
    const element = stackRef.current
    if (!element) return false
    const viewport = element.closest<HTMLElement>('[data-dock-viewport]')
    return canSplitPane(Math.min(element.clientWidth, viewport?.clientWidth ?? element.clientWidth),
      Math.min(element.clientHeight, viewport?.clientHeight ?? element.clientHeight),
      layoutMinimum(stack, (id) => resolvePanel(id)?.type))
  }, [stack, resolvePanel])
  useEffect(() => {
    const update = () => setSplitAllowed(canSplit())
    update()
    const observer = new ResizeObserver(update)
    if (stackRef.current) {
      observer.observe(stackRef.current)
      const viewport = stackRef.current.closest('[data-dock-viewport]')
      if (viewport) observer.observe(viewport)
    }
    return () => observer.disconnect()
  }, [canSplit])

  // Set while the visible panel's own UI covers its top-right corner (see the
  // worktree chip below, which otherwise overlays exactly there).
  const [cornerClaimed, setCornerClaimed] = useState(false)
  const chromeApi = useMemo<PanelChromeApi>(() => ({ setCornerClaimed }), [])

  // Tab interaction actions (rename, click, context menus, add/split helpers).
  const actions = useDockTabActions({
    stack,
    canSplit,
    zone: zoneProp,
    dockStoreApi,
    workspaceId: workspaceIdProp,
    getPanelProp: resolvePanel,
    onClosePanel, onClosePanels,
    onPanelRemoved,
    onPanelRenamed,
    excludePanelTypes,
    localOnly,
  })

  // Main-dock tab drag (canvas-node mini-docks route through onTabBarMouseDown).
  const { handleTabMouseDown } = useDockTabDrag({
    stackId: stack.id,
    zone: zoneProp,
    dockStoreApi,
    getPanel: resolvePanel,
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

  const springLoadTimer = useRef<number | null>(null)

  useEffect(() => {
    return () => {
      if (springLoadTimer.current) {
        window.clearTimeout(springLoadTimer.current)
        springLoadTimer.current = null
      }
    }
  }, [])


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

  // Center-zone tabs float over the panel body ONLY for a canvas, so the canvas
  // grid shows through behind the chromeless header. For any other panel type a
  // floating header would leave the panel's own content/toolbar (e.g. an editor's
  // markdown Preview strip) sitting behind the tabs AND the window chrome
  // (traffic-light island / sidebar toggles), which reads as a broken overlay. So
  // non-canvas center stacks use a solid, in-flow strip that pushes content down —
  // exactly like the docked side/bottom stacks.
  const floatingCenterTabs =
    !compact && zoneProp === 'center' && activePanel?.type === 'canvas'

  return (
    <div
      ref={stackRef}
      // Lets an ancestor map a pointer target back to the leaf stack it landed
      // in — CanvasNode uses it to learn WHICH pane of a split mini-dock the
      // user pressed, so focus goes to that pane and not the first leaf.
      data-dock-stack-id={stack.id}
      className="flex flex-col h-full min-h-0 relative"
      // Mark this stack's active tab as the active panel on any pointer-down
      // inside it (tab bar OR content), so a panel-create shortcut lands here —
      // even in a split and even when the click didn't land on a focusable
      // element. Capture phase so a canvas docked in this stack can re-assert
      // itself on the bubble phase (CanvasPanel sets the same canvas panel, so
      // they agree). `localOnly` mini-docks (canvas nodes) opt out — they must
      // not steal the window-global active panel.
      onPointerDownCapture={
        localOnly
          ? undefined
          : () => {
              const activePanelId = stack.panelIds[stack.activeIndex]
              if (activePanelId) setActivePanel(activePanelId)
            }
      }
    >
      {/* Tab bar — VS Code style: dark strip with active tab merging into the
          content area below via a top accent border. */}
      <div
        className={`dock-tab-bar flex items-center overflow-hidden ${
          // The canvas header floats: it's positioned absolutely so the canvas
          // content fills the full height BEHIND it, and its background + divider
          // stay transparent until hovered (see .dock-tab-bar-floating in
          // globals.css) — so at rest only the tabs and buttons read against the
          // canvas grid. Canvas-node mini-docks (compact) also go chromeless: no
          // solid band, no divider — the tabs float directly on the panel body so
          // the active pill nests into the node's rounded corner. Docked side/bottom
          // stacks AND non-canvas center stacks keep the solid, in-flow chrome +
          // divider (so their panel content isn't occluded — see floatingCenterTabs).
          floatingCenterTabs
            ? `dock-tab-bar-floating absolute top-0 left-0 right-0 z-20 ${showTabPlaceholder ? 'drop-active' : ''}`
            : compact || activePanel?.type === 'editor'
              ? ''
              : 'border-b border-subtle'
        } ${compact ? 'min-h-[26px] px-0.5' : 'app-header-bar'}`}
        style={{
          ...(!compact && !floatingCenterTabs
            ? { backgroundColor: 'var(--node-chrome-bg, var(--surface-1))' }
            : null),
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
          springLoadTimer={springLoadTimer}
          setActiveTab={actions.setActiveTab}
          onEmptyMouseDown={(e) => onTabBarMouseDown?.(e)}
          onEmptyContextMenu={onEmptyContextMenu}
          showTabPlaceholder={showTabPlaceholder}
          selfTabDrag={selfTabDrag}
          onTabBarMouseDown={onTabBarMouseDown}
          newTabControl={newTabControl ?? <NewTabButton canvasAttached={localOnly} compact={compact} items={visibleSplitItems} onPick={actions.addTabOfType} />}
        />

        {activePanelId && (
          <Tooltip label={splitAllowed ? "Split Right" : "Not enough space. Resize this pane or open a tab."}>
            <button
              className={`flex items-center justify-center self-center rounded-[10px] text-muted hover:text-primary hover:bg-hover cursor-pointer ${compact ? 'w-[22px] h-[22px]' : 'w-6 h-6'}`}
              aria-label="Split Right"
              disabled={!splitAllowed}
              style={!splitAllowed ? { opacity: 0.4, cursor: 'not-allowed' } : undefined}
              onClick={() => actions.splitPanel()}
            >
              <Columns size={compact ? 12 : 14} />
            </button>
          </Tooltip>
        )}

        {canMaximize && <Tooltip label={maximized ? 'Restore split' : 'Maximize split'}>
          <button
            type="button"
            aria-label={maximized ? 'Restore split' : 'Maximize split'}
            aria-pressed={maximized}
            className={`flex items-center justify-center self-center rounded-[10px] text-muted hover:text-primary hover:bg-hover cursor-pointer ${compact ? 'w-[22px] h-[22px]' : 'w-6 h-6'}`}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={() => dockStoreApi.getState().toggleStackMaximized(stack.id)}
          >
            {maximized ? <Minimize2 size={compact ? 12 : 14} /> : <Maximize2 size={compact ? 12 : 14} />}
          </button>
        </Tooltip>}

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

      {/* Panel content. Each panel gets its OWN stable keyed slot (keyed by panel
          id): switching between two tabs of the SAME component type
          (canvas↔canvas, terminal↔terminal) must remount the content, not reuse
          the instance with a swapped panelId — panels wire store subscriptions in
          mount-only effects, so a reused instance keeps driving the previous
          panel's store (visible canvas transformed by the hidden canvas's
          zoom/offset).

          Ordinary panels render only while active and unmount otherwise (freeing
          xterm/WebGL, Monaco, etc.). Webview-backed panels
          (keepsMountedWhenTabHidden: browser/agent) instead stay MOUNTED but
          hidden when inactive, so their live `<webview>` guest process survives a
          tab switch — unmounting and remounting would reload the page and lose all
          in-page state (#459). Because each keep-alive panel keeps its stable
          keyed slot, toggling active only flips visibility rather than
          remounting. */}
      <div className="flex-1 min-h-0 overflow-hidden relative">
        {activePanelId ? (
          stack.panelIds.map((panelId) => {
            const isActive = panelId === activePanelId
            const keepAlive = keepsMountedWhenTabHidden(resolvePanel(panelId)?.type)
            if (!isActive && !keepAlive) return null
            return (
              <div
                key={panelId}
                className="absolute inset-0"
                // visibility:hidden (not display:none) keeps the hidden webview
                // laid out at full size so it's ready the instant its tab is
                // reselected; pointer-events:none stops the hidden layer from
                // intercepting clicks meant for the active panel.
                style={isActive ? undefined : { visibility: 'hidden', pointerEvents: 'none' }}
                aria-hidden={isActive ? undefined : true}
              >
                <PanelChromeProvider api={chromeApi} enabled={isActive}>
                  {resolvePanel(panelId)?.type === 'surface'
                    ? <SurfacePicker onSelect={actions.chooseSurface} excludePanelTypes={excludePanelTypes} />
                    : renderPanel(panelId)}
                </PanelChromeProvider>
              </div>
            )
          })
        ) : (
          <div className="flex items-center justify-center h-full text-muted text-sm">
            No panel
          </div>
        )}
        {/* Terminal worktree chip — overlaid on the panel's top-right rather than crammed
            into the tab strip (where it starved the title). Collapsed to its icon
            until hovered so it covers almost no content (#370). Self-hides for
            single-worktree workspaces, and stands
            down while the panel claims the corner for its own UI (see
            panelChrome) rather than sitting on top of it. */}
        {activePanel?.type === 'terminal' && effectiveWorkspaceId && !cornerClaimed && (
          // right-3 (12px), not right-1.5: terminal panels reserve a 6px
          // scrollbar lane (overflow-y: scroll). Offset
          // past it so the chip clears the scrollbar and leaves a 6px gap that
          // matches the 6px top inset (top-1.5).
          <div data-browser-surface-overlay={activePanel.id} className="absolute top-1.5 right-3 z-10 flex items-center gap-1">
            <WorktreePill panel={activePanel} workspaceId={effectiveWorkspaceId} />
            <AgentChangesPill key={`changes:${activePanel.id}`} panel={activePanel} workspaceId={effectiveWorkspaceId} />
          </div>
        )}
      </div>

    </div>
  )
}
