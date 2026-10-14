// A dock stack: its tab bar and its panels. The active tab is client state.
// Ordinary panels render only while active; panels with a native surface stay
// mounted and hidden so their page survives a tab switch. The same component
// draws window stacks and canvas node mini docks (`compact`).

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Columns2 as Columns, GripVertical, Maximize2, Minimize2, X } from 'lucide-react'
import {
  isNodeHost,
  type DockNode,
  type DockRef,
  type HostRef,
  type DockStack,
  type PanelRecord,
} from '@workspace/document/contract'
import { Tooltip } from '../../../kernel/interaction'
import { clientStateFor } from '@client/document'
import { useClientState, useDocument } from '../../document'
import { PanelChromeProvider, type PanelChromeApi } from '../../host/panelChrome'
import { PanelPlacementContext } from '../../host/PanelHost'
import { PanelVisibilityContext } from '../../host/PanelSessionBoundary'
import { activeTabOf, keepsMounted, panelDefinition } from '@client/host'
import { registerDropZone } from '../drag/registry'
import { useDragStore } from '../drag/store'
import { useDragOp } from '../drag/useDragOp'
import { panelChromeOverlays } from './decorations'
import { DockTabBar } from './DockTabBar'
import { NewTabButton, newTabItems } from './NewTabMenu'
import { canSplitLayout, canSplitPane, layoutMinimum } from './sizing'
import { useDockTabActions } from './useDockTabActions'

export interface DockTabStackProps {
  workspaceId: string
  dock: DockRef
  host: HostRef
  stack: DockStack
  /** The drawn tree of the whole dock (for split sizing). */
  layout: DockNode
  /** Renders one panel's view (PanelHost by default in DockView). */
  renderPanel: (panelId: string) => React.ReactNode
  /** Controls after the split and maximize buttons (a node's close). */
  trailingControls?: React.ReactNode
  newTabControl?: React.ReactNode
  /** Set by a host that drags the whole node from its tab bar; gets the tab
   *  pressed, if any. Replaces the tab drag. */
  onTabBarMouseDown?: (e: React.MouseEvent, panelId?: string) => void
  /** A slimmer tab bar (canvas node mini docks). */
  compact?: boolean
  /** The stack is not a drop target (its node is being dragged). */
  dropDisabled?: boolean
  /** Space the tab bar leaves at its left for window chrome (the top-left
   *  stack of a window under the macOS traffic lights). */
  leadingInset?: number
}

function useStackRecords(workspaceId: string, stack: DockStack): (PanelRecord | undefined)[] {
  const selector = useMemo(() => (doc: { panels: Record<string, PanelRecord> }) => stack.panels.map((id) => doc.panels[id]), [stack])
  return useDocument(workspaceId, selector, (a, b) => a.length === b.length && a.every((r, i) => r === b[i]))
}

export function DockTabStack({
  workspaceId, dock, host, stack, layout, renderPanel, trailingControls, newTabControl,
  onTabBarMouseDown, compact, dropDisabled, leadingInset,
}: DockTabStackProps) {
  const activePanelId = useClientState(workspaceId, (s) => activeTabOf(s.activeTabs, stack))
  const records = useStackRecords(workspaceId, stack)
  const recordOf = useCallback((id: string) => records[stack.panels.indexOf(id)], [records, stack.panels])
  const activeRecord = activePanelId ? recordOf(activePanelId) : undefined
  const focusedHere = useClientState(workspaceId, (s) => !!activePanelId && s.focusedPanelId === activePanelId)
  const stackRef = useRef<HTMLDivElement>(null)
  const onCanvas = isNodeHost(host)

  // --- Maximize / restore -----------------------------------------------------------
  // Client state: a window stack shows alone in its window, a canvas node
  // fills its canvas. Nobody else's layout changes.
  const restorable = useClientState(workspaceId, (s) => (isNodeHost(host)
    ? s.maximizedNodes[host.canvasId] === host.nodeId
    : s.maximizedStacks[host.windowId] === stack.id))
  const maximizable = !restorable && (onCanvas || layout.kind === 'split')
  const toggleMaximized = useCallback(() => {
    const state = clientStateFor(workspaceId)
    if (!state) return
    if (isNodeHost(host)) state.setMaximizedNode(host.canvasId, restorable ? null : host.nodeId)
    else state.setMaximizedStack(host.windowId, restorable ? null : stack.id)
  }, [workspaceId, host, restorable, stack.id])

  // --- Drop target -------------------------------------------------------------------
  const dropDisabledRef = useRef(false)
  dropDisabledRef.current = !!dropDisabled
  const tabCountRef = useRef(stack.panels.length)
  tabCountRef.current = stack.panels.length
  // A one-panel window pane has no tab bar (its chip floats), so a drag splits it anywhere.
  const hasTabBarRef = useRef(true)
  hasTabBarRef.current = onCanvas || stack.panels.length > 1
  useEffect(() => registerDropZone({
    id: `stack-${workspaceId}-${stack.id}`,
    workspaceId,
    dock,
    host,
    stackId: stack.id,
    getRect: () => (dropDisabledRef.current ? null : stackRef.current?.getBoundingClientRect() ?? null),
    getElement: () => stackRef.current,
    tabCount: () => tabCountRef.current,
    hasTabBar: () => hasTabBarRef.current,
  }), [workspaceId, dock, host, stack.id])

  // --- Split room ----------------------------------------------------------------------
  const typeOf = useCallback((id: string) => recordOf(id)?.type, [recordOf])
  const [splitAllowed, setSplitAllowed] = useState(false)
  const canSplit = useCallback(() => {
    const element = stackRef.current
    if (!element) return false
    const viewport = element.closest<HTMLElement>('[data-dock-viewport]')
    if (viewport) return canSplitLayout(layout, stack.id, viewport.clientWidth, viewport.clientHeight, typeOf)
    return canSplitPane(element.clientWidth, element.clientHeight, layoutMinimum(stack, typeOf))
  }, [layout, stack, typeOf])
  useEffect(() => {
    const update = () => setSplitAllowed(canSplit())
    update()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(update)
    if (stackRef.current) {
      observer.observe(stackRef.current)
      const viewport = stackRef.current.closest('[data-dock-viewport]')
      if (viewport) observer.observe(viewport)
    }
    return () => observer.disconnect()
  }, [canSplit])

  // The worktree chip stands down while the view claims the corner.
  const [cornerClaimed, setCornerClaimed] = useState(false)
  // A view with a toolbar of its own draws the pane's controls there.
  const [controlsClaimed, setControlsClaimed] = useState(false)
  const placementLimits = useMemo(() => ({ onCanvas }), [onCanvas])

  const actions = useDockTabActions({ workspaceId, dock, host, stack, activePanelId, canSplit })
  const { handleDragStart } = useDragOp()
  const menuItems = useMemo(() => newTabItems({ onCanvas }), [onCanvas])
  const onEmptyContextMenu = useCallback((e: React.MouseEvent) => { void actions.handleTabBarContextMenu(e) }, [actions])

  const springLoadTimer = useRef<number | null>(null)
  useEffect(() => () => {
    if (springLoadTimer.current) window.clearTimeout(springLoadTimer.current)
  }, [])

  // --- Drag feedback ---------------------------------------------------------------------
  const isDragging = useDragStore((s) => s.isDragging)
  const target = useDragStore((s) => s.target)
  const dragSource = useDragStore((s) => s.source)
  const showTabPlaceholder = isDragging && target?.kind === 'dock-tab' && target.workspaceId === workspaceId && target.stackId === stack.id
  const selfTabDrag = useMemo(() => {
    if (!showTabPlaceholder || !dragSource || dragSource.origin.kind !== 'dock-tab' || dragSource.origin.stackId !== stack.id) return null
    const index = stack.panels.indexOf(dragSource.panelId)
    return index < 0 ? null : { draggedPanelId: dragSource.panelId, originalIndex: index }
  }, [showTabPlaceholder, dragSource, stack.id, stack.panels])

  // A floating tab bar (a canvas) lets the view show behind it.
  const floating = !compact && !!activeRecord && !!panelDefinition(activeRecord.type)?.chrome?.floatingTabBar
  const flush = !!activeRecord && !!panelDefinition(activeRecord.type)?.chrome?.flushTabBar
  const worktreeChip = !!activeRecord && !!panelDefinition(activeRecord.type)?.chrome?.worktreeChip
  const buttonSize = compact ? 'w-[22px] h-[22px]' : 'w-6 h-6'
  // A window pane holding one panel has no tab bar: its controls float in the
  // pane's top-right corner. More panels bring the tab bar back.
  const chipMode = !onCanvas && stack.panels.length === 1
  // Controls only help a pane that is part of a split: a lone pane has nothing to
  // drag to, close from or maximize in (its tab and the strip do that).
  const hasPaneControls = chipMode && layout.kind === 'split'
  // The pane's controls: where they are drawn (floating, or in a view's toolbar) is the host's call.
  const paneButtons = hasPaneControls && activePanelId ? (
    <>
      {(restorable || maximizable) && (
        <button
          type="button"
          aria-label={restorable ? 'Restore' : 'Maximize'}
          aria-pressed={restorable}
          className="flex items-center justify-center w-6 h-6 rounded-[10px] text-muted hover:text-primary hover:bg-hover cursor-pointer"
          onClick={toggleMaximized}
        >
          {restorable ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        </button>
      )}
      <span
        aria-label="Drag"
        data-pane-drag={activePanelId}
        className="flex items-center justify-center w-5 h-6 text-muted hover:text-primary cursor-grab"
        onMouseDown={(e) => handleDragStart(e, { kind: 'dock-tab', workspaceId, dock, host, stackId: stack.id, panelId: activePanelId })}
      >
        <GripVertical size={14} />
      </span>
      <Tooltip label="Close">
        <button
          className="flex items-center justify-center w-6 h-6 rounded-[10px] text-muted hover:text-red-400 hover:bg-hover cursor-pointer"
          aria-label="Close panel"
          onClick={() => actions.closePanel(activePanelId)}
        >
          <X size={14} />
        </button>
      </Tooltip>
    </>
  ) : null
  // Only a view that fills its pane (the terminal) fades them; the rest keep them in sight.
  const fadeControls = !!activeRecord && !!panelDefinition(activeRecord.type)?.chrome?.hoverPaneControls && !focusedHere
  const controlsShown = fadeControls ? 'opacity-0 pointer-events-none group-hover/pane:opacity-100 group-hover/pane:pointer-events-auto' : ''
  const chipControls = hasPaneControls && !controlsClaimed && !!activePanelId
  // What views add to a panel's corner (the agent changes pill, the worktree chip): in the pane's chip when it has
  // controls, so the corner is one chip, else on its own.
  const cornerOverlays = activeRecord && worktreeChip && !cornerClaimed && panelChromeOverlays().length > 0 && (
    <div data-browser-surface-overlay={activeRecord.id} className="flex items-center gap-1">
      {panelChromeOverlays().map((Overlay, i) => <Overlay key={i} workspaceId={workspaceId} record={activeRecord} />)}
    </div>
  )
  const chromeApi: PanelChromeApi = {
    setCornerClaimed,
    setControlsClaimed,
    paneControls: paneButtons
      ? <div data-pane-controls={stack.id} className={`flex items-center shrink-0 transition-opacity ${controlsShown}`}>{paneButtons}</div>
      : null,
  }

  return (
    <div
      ref={stackRef}
      // Lets a canvas node learn which pane of its split mini dock was pressed.
      data-dock-stack-id={stack.id}
      className="group/pane flex flex-col h-full min-h-0 relative"
      // A press anywhere in the stack focuses its shown tab, so a new panel
      // lands here. Capture, so a canvas inside can refine it on bubble.
      onPointerDownCapture={() => {
        if (activePanelId && !onCanvas) clientStateFor(workspaceId)?.focus(activePanelId)
      }}
    >
      {!chipMode && <div
        className={`dock-tab-bar flex items-center overflow-hidden ${
          floating
            ? `dock-tab-bar-floating absolute top-0 left-0 right-0 z-20 ${showTabPlaceholder ? 'drop-active' : ''}`
            : compact || flush ? '' : 'border-b border-subtle'
        } ${compact ? 'min-h-[26px] px-0.5' : 'app-header-bar'}`}
        style={{
          ...(!compact && !floating ? { backgroundColor: 'var(--node-chrome-bg, var(--surface-1))' } : null),
          ...(onTabBarMouseDown ? { cursor: 'grab' } : null),
          ...(leadingInset ? { paddingLeft: leadingInset } : null),
        }}
        onContextMenu={onEmptyContextMenu}
        onMouseDown={(e) => {
          if (e.target !== e.currentTarget) return
          onTabBarMouseDown?.(e)
        }}
      >
        <DockTabBar
          workspaceId={workspaceId}
          stack={stack}
          activePanelId={activePanelId}
          compact={compact}
          onClosePanel={actions.closePanel}
          onTabClick={actions.handleTabClick}
          onTabMouseDown={(e, panelId) => {
            if (onTabBarMouseDown) {
              onTabBarMouseDown(e, panelId)
              return
            }
            handleDragStart(e, { kind: 'dock-tab', workspaceId, dock, host, stackId: stack.id, panelId })
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
          onEmptyMouseDown={onTabBarMouseDown ? (e) => onTabBarMouseDown(e) : undefined}
          onEmptyContextMenu={onEmptyContextMenu}
          showTabPlaceholder={showTabPlaceholder}
          selfTabDrag={selfTabDrag}
          onTabBarMouseDown={onTabBarMouseDown}
          newTabControl={newTabControl ?? <NewTabButton canvasAttached={onCanvas} compact={compact} items={menuItems} onPick={actions.addTabOfType} />}
        />

        {activePanelId && onCanvas && (
          <Tooltip label={splitAllowed ? 'Split right' : 'Not enough space to split'}>
            <button
              className={`flex items-center justify-center self-center rounded-[10px] text-muted hover:text-primary hover:bg-hover cursor-pointer ${buttonSize}`}
              aria-label="Split Right"
              disabled={!splitAllowed}
              style={!splitAllowed ? { opacity: 0.4, cursor: 'not-allowed' } : undefined}
              onClick={() => actions.splitPanel()}
            >
              <Columns size={compact ? 12 : 14} />
            </button>
          </Tooltip>
        )}

        {(restorable || maximizable) && (
          <Tooltip label={restorable ? 'Restore' : 'Maximize'}>
            <button
              type="button"
              aria-label={restorable ? 'Restore' : 'Maximize'}
              aria-pressed={restorable}
              className={`flex items-center justify-center self-center rounded-[10px] text-muted hover:text-primary hover:bg-hover cursor-pointer ${buttonSize}`}
              onMouseDown={(event) => event.stopPropagation()}
              onClick={toggleMaximized}
            >
              {restorable ? <Minimize2 size={compact ? 12 : 14} /> : <Maximize2 size={compact ? 12 : 14} />}
            </button>
          </Tooltip>
        )}

        {trailingControls && (
          <div className="flex items-center self-center pr-1 gap-0.5" onMouseDown={(e) => e.stopPropagation()}>
            {trailingControls}
          </div>
        )}
      </div>}

      <div className="flex-1 min-h-0 overflow-hidden relative" data-worktree-room>
        {activePanelId ? (
          stack.panels.map((panelId) => {
            const isActive = panelId === activePanelId
            // Each panel has its own keyed slot: switching between two tabs
            // of one type remounts rather than reusing a view.
            if (!isActive && !keepsMounted(recordOf(panelId)?.type)) return null
            return (
              <div
                key={panelId}
                className="absolute inset-0"
                // visibility, not display: a hidden surface keeps its size.
                style={isActive ? undefined : { visibility: 'hidden', pointerEvents: 'none' }}
                aria-hidden={isActive ? undefined : true}
              >
                <PanelVisibilityContext.Provider value={isActive}>
                  <PanelChromeProvider api={chromeApi} enabled={isActive}>
                    <PanelPlacementContext.Provider value={placementLimits}>{renderPanel(panelId)}</PanelPlacementContext.Provider>
                  </PanelChromeProvider>
                </PanelVisibilityContext.Provider>
              </div>
            )
          })
        ) : (
          <div className="flex items-center justify-center h-full text-muted text-sm">No panel</div>
        )}
        {((hasPaneControls && !controlsClaimed) || (activeRecord && worktreeChip && !cornerClaimed && panelChromeOverlays().length > 0)) && (
          // Clears the terminal's 6px scrollbar lane.
          <div
            // A one-panel pane's corner (overlays and chip) shows for the focused pane and the one under the cursor.
            className={`absolute top-1.5 right-3 z-10 flex items-center gap-1 transition-opacity ${
              hasPaneControls && !controlsClaimed && fadeControls ? 'opacity-0 pointer-events-none group-hover/pane:opacity-100 group-hover/pane:pointer-events-auto' : ''}`}
          >
            {chipControls
              ? <div data-pane-chip={stack.id} className="flex items-center rounded-[10px] bg-surface-1/90 backdrop-blur-sm shadow-sm">
                {cornerOverlays && <div className="pl-1.5">{cornerOverlays}</div>}
                {paneButtons}
              </div>
              : cornerOverlays}
          </div>
        )}
      </div>
      {/* The focused pane of a split window layout. */}
      {focusedHere && !onCanvas && layout.kind === 'split' && (
        <div
          aria-hidden
          data-active-pane={stack.id}
          className="pointer-events-none absolute inset-0 z-30"
          style={{ boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--focus-blue, #3b82f6) 50%, transparent)' }}
        />
      )}
    </div>
  )
}

