// A dock stack: its tab bar and its panels. The active tab is client state.
// Ordinary panels render only while active; panels with a native surface stay
// mounted and hidden so their page survives a tab switch. The same component
// draws window stacks and canvas node mini docks (`compact`).

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Columns2 as Columns, Maximize2, Minimize2 } from 'lucide-react'
import {
  isCanvasDock,
  type DockNode,
  type DockRef,
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
  workspaceId, dock, stack, layout, renderPanel, trailingControls, newTabControl,
  onTabBarMouseDown, compact, dropDisabled, leadingInset,
}: DockTabStackProps) {
  const activePanelId = useClientState(workspaceId, (s) => activeTabOf(s.activeTabs, stack))
  const records = useStackRecords(workspaceId, stack)
  const recordOf = useCallback((id: string) => records[stack.panels.indexOf(id)], [records, stack.panels])
  const activeRecord = activePanelId ? recordOf(activePanelId) : undefined
  const stackRef = useRef<HTMLDivElement>(null)
  const onCanvas = isCanvasDock(dock)

  // --- Maximize / restore -----------------------------------------------------------
  // Client state: a window stack shows alone in its window, a canvas node
  // fills its canvas. Nobody else's layout changes.
  const restorable = useClientState(workspaceId, (s) => (isCanvasDock(dock)
    ? s.maximizedNodes[dock.canvasId] === dock.nodeId
    : s.maximizedStacks[dock.windowId] === stack.id))
  const maximizable = !restorable && (onCanvas || layout.kind === 'split')
  const toggleMaximized = useCallback(() => {
    const state = clientStateFor(workspaceId)
    if (!state) return
    if (isCanvasDock(dock)) state.setMaximizedNode(dock.canvasId, restorable ? null : dock.nodeId)
    else state.setMaximizedStack(dock.windowId, restorable ? null : stack.id)
  }, [workspaceId, dock, restorable, stack.id])

  // --- Drop target -------------------------------------------------------------------
  const dropDisabledRef = useRef(false)
  dropDisabledRef.current = !!dropDisabled
  const tabCountRef = useRef(stack.panels.length)
  tabCountRef.current = stack.panels.length
  useEffect(() => registerDropZone({
    id: `stack-${workspaceId}-${stack.id}`,
    workspaceId,
    dock,
    stackId: stack.id,
    getRect: () => (dropDisabledRef.current ? null : stackRef.current?.getBoundingClientRect() ?? null),
    getElement: () => stackRef.current,
    tabCount: () => tabCountRef.current,
  }), [workspaceId, dock, stack.id])

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
  const chromeApi = useMemo<PanelChromeApi>(() => ({ setCornerClaimed }), [])
  const placementLimits = useMemo(() => ({ onCanvas }), [onCanvas])

  const actions = useDockTabActions({ workspaceId, dock, stack, activePanelId, canSplit })
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

  return (
    <div
      ref={stackRef}
      // Lets a canvas node learn which pane of its split mini dock was pressed.
      data-dock-stack-id={stack.id}
      className="flex flex-col h-full min-h-0 relative"
      // A press anywhere in the stack focuses its shown tab, so a new panel
      // lands here. Capture, so a canvas inside can refine it on bubble.
      onPointerDownCapture={() => {
        if (activePanelId && !onCanvas) clientStateFor(workspaceId)?.focus(activePanelId)
      }}
    >
      <div
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
            handleDragStart(e, { kind: 'dock-tab', workspaceId, dock, stackId: stack.id, panelId })
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

        {activePanelId && (
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
      </div>

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
        {activeRecord && worktreeChip && !cornerClaimed && panelChromeOverlays().length > 0 && (
          // Clears the terminal's 6px scrollbar lane.
          <div data-browser-surface-overlay={activeRecord.id} className="absolute top-1.5 right-3 z-10 flex items-center gap-1">
            {panelChromeOverlays().map((Overlay, i) => <Overlay key={i} workspaceId={workspaceId} record={activeRecord} />)}
          </div>
        )}
      </div>
    </div>
  )
}
