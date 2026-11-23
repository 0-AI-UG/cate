// The row of tab pills of a stack: icon, title (or the rename input), status
// marks and the close button, then the new-tab button and a spacer.

import React from 'react'
import { X } from 'lucide-react'
import type { DockStack, PanelRecord } from '@workspace/document/contract'
import { Tooltip } from '../../../kernel/interaction'
import { useDocument } from '../../document'
import { panelDefinition } from '@client/host'
import { isMiddleClick } from '../drag/dom'
import { useDragStore } from '../drag/store'
import { useTabSourceVisibility } from '../drag/selectors'
import { PanelTitle, usePanelTitles } from '../../host'

/** A tab pill; hidden while it is the dragged tab. */
export const TabPill = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement> & {
  panelId: string
  baseStyle: React.CSSProperties
}>(function TabPill({ panelId, baseStyle, style, children, ...rest }, ref) {
  const { hidden } = useTabSourceVisibility(panelId)
  const merged: React.CSSProperties = hidden
    ? { ...baseStyle, ...style, opacity: 0, pointerEvents: 'none' }
    : { ...baseStyle, ...style }
  return (
    <div ref={ref} data-tab-panel-id={panelId} style={merged} {...rest}>
      {children}
    </div>
  )
})

export interface DockTabBarProps {
  workspaceId: string
  stack: DockStack
  activePanelId: string | undefined
  compact?: boolean
  onTabClick: (panelId: string) => void
  onTabMouseDown: (e: React.MouseEvent, panelId: string) => void
  onTabContextMenu: (e: React.MouseEvent, panelId: string) => void
  onClosePanel?: (panelId: string) => void
  renameId: string | null
  renameValue: string
  renameInputRef: React.MutableRefObject<HTMLInputElement | null>
  setRenameValue: (v: string) => void
  setRenameId: (id: string | null) => void
  commitRename: (panelId: string) => void
  /** Spring-load: hovering a tab mid-drag selects it after a delay. */
  springLoadTimer: React.MutableRefObject<number | null>
  setActiveTab: (panelId: string) => void
  onEmptyMouseDown?: (e: React.MouseEvent) => void
  onEmptyContextMenu?: (e: React.MouseEvent) => void
  showTabPlaceholder: boolean
  /** The dragged tab comes from this stack: hide it and put the placeholder
   *  at its old place. */
  selfTabDrag?: { draggedPanelId: string; originalIndex: number } | null
  newTabControl?: React.ReactNode
  /** Set by a host that drags the whole node from the tab bar. */
  onTabBarMouseDown?: (e: React.MouseEvent, panelId?: string) => void
}

const selectTabRecords = (stack: DockStack) => (doc: { panels: Record<string, PanelRecord> }) => stack.panels.map((id) => doc.panels[id])
const sameTabRecords = (a: ReturnType<ReturnType<typeof selectTabRecords>>, b: ReturnType<ReturnType<typeof selectTabRecords>>) =>
  a.length === b.length && a.every((record, index) => record === b[index])

export function DockTabBar(props: DockTabBarProps) {
  const {
    workspaceId, stack, activePanelId, compact, onClosePanel,
    onTabClick, onTabMouseDown, onTabContextMenu,
    renameId, renameValue, renameInputRef, setRenameValue, setRenameId, commitRename,
    springLoadTimer, setActiveTab,
    onEmptyMouseDown, onEmptyContextMenu,
    showTabPlaceholder, selfTabDrag, onTabBarMouseDown, newTabControl,
  } = props

  const selector = React.useMemo(() => selectTabRecords(stack), [stack])
  const records = useDocument(workspaceId, selector, sameTabRecords)
  const titles = usePanelTitles(workspaceId)

  // Clamped to at least 1: a leading tab's drag lets the next tab take slot
  // 0 and the placeholder follows it.
  const remaining = selfTabDrag ? stack.panels.filter((id) => id !== selfTabDrag.draggedPanelId) : stack.panels
  const placeholderAt = selfTabDrag ? Math.min(Math.max(selfTabDrag.originalIndex, 1), remaining.length) : remaining.length

  const placeholder = showTabPlaceholder ? (
    <div
      key="__tab-placeholder__"
      aria-hidden
      className={`flex flex-shrink-0 items-center justify-center whitespace-nowrap select-none rounded-[10px] ${compact ? 'h-[22px] px-2 text-[11px]' : 'h-6 px-3 text-[12px]'}`}
      style={{
        minWidth: 100,
        color: 'var(--focus-blue, #3b82f6)',
        backgroundColor: 'color-mix(in srgb, var(--focus-blue, #3b82f6) 18%, transparent)',
        border: '1px dashed color-mix(in srgb, var(--focus-blue, #3b82f6) 70%, transparent)',
        borderRadius: 10,
      }}
    >
      + new tab
    </div>
  ) : null

  return (
    <div
      className={`flex items-center flex-1 min-w-0 ${compact ? 'gap-0.5' : 'gap-1'}`}
      style={onEmptyMouseDown ? { cursor: 'grab' } : undefined}
      onContextMenu={onEmptyContextMenu}
      onMouseDown={(e) => {
        if (e.target !== e.currentTarget) return
        onEmptyMouseDown?.(e)
      }}
    >
      {remaining.flatMap((panelId, visibleIndex) => {
        const record = records[stack.panels.indexOf(panelId)]
        const isActive = panelId === activePanelId
        const type = record?.type ?? ''
        const definition = panelDefinition(type)
        const title = record ? titles.label(record) : ''
        const pill = (
          <TabPill
            key={panelId}
            panelId={panelId}
            className={`
              group relative flex items-center gap-1.5 whitespace-nowrap
              cursor-grab select-none min-w-0 shrink rounded-[var(--node-tab-radius,10px)] transition-colors
              ${compact ? 'h-[22px] max-w-[160px] pl-2 text-[11px]' : 'h-6 max-w-[200px] pl-2.5 text-[12px]'}
              ${onClosePanel ? 'pr-1' : compact ? 'pr-2' : 'pr-2.5'}
              ${isActive ? 'bg-surface-2 text-primary' : 'text-muted hover:text-secondary hover:bg-hover dock-tab-inactive'}
            `}
            onClick={() => onTabClick(panelId)}
            onMouseDown={(e) => {
              // Middle click closes on auxclick: no autoscroll, no drag.
              if (isMiddleClick(e)) { e.preventDefault(); return }
              onTabMouseDown(e, panelId)
            }}
            onAuxClick={(e) => {
              if (isMiddleClick(e) && onClosePanel) {
                e.preventDefault()
                e.stopPropagation()
                onClosePanel(panelId)
              }
            }}
            onContextMenu={(e) => onTabContextMenu(e, panelId)}
            onPointerEnter={() => {
              if (isActive || !useDragStore.getState().isDragging) return
              if (springLoadTimer.current) window.clearTimeout(springLoadTimer.current)
              // A tab whose view is a drop surface (a canvas) opens sooner.
              const delay = definition?.chrome?.floatingTabBar ? 250 : 600
              springLoadTimer.current = window.setTimeout(() => setActiveTab(panelId), delay)
            }}
            onPointerLeave={() => {
              if (springLoadTimer.current) {
                window.clearTimeout(springLoadTimer.current)
                springLoadTimer.current = null
              }
            }}
            baseStyle={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
            title={title}
          >
            {record && <PanelTitle {...titles.props(record)} iconSize={compact ? 11 : 13} iconClassName={isActive ? definition?.tint ?? 'text-secondary' : 'text-muted'}>
            {renameId === panelId ? (
              <input
                ref={renameInputRef}
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onBlur={() => commitRename(panelId)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); commitRename(panelId) }
                  else if (e.key === 'Escape') { e.preventDefault(); setRenameId(null) }
                  e.stopPropagation()
                }}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => e.stopPropagation()}
                className="truncate flex-1 min-w-0 bg-transparent outline-none border-b border-focus text-primary px-0"
                style={{ font: 'inherit' }}
              />
            ) : undefined}
            </PanelTitle>}
            {onClosePanel && (
              <Tooltip label="Close panel" action={isActive ? 'closePanel' : undefined}>
                <span
                  className={`shrink-0 p-0.5 rounded-md text-muted hover:text-red-400 hover:bg-hover cursor-pointer transition-opacity ${
                    isActive ? 'opacity-70' : 'opacity-0 group-hover:opacity-100'
                  }`}
                  onClick={(e) => {
                    e.stopPropagation()
                    onClosePanel(panelId)
                  }}
                >
                  <X size={compact ? 12 : 11} />
                </span>
              </Tooltip>
            )}
          </TabPill>
        )
        return placeholder && visibleIndex === placeholderAt ? [placeholder, pill] : [pill]
      })}
      {placeholder && placeholderAt >= remaining.length && placeholder}
      {newTabControl}
      {/* Fills the row; drags the window, or the node when the host says so. */}
      <div
        className="flex-1 min-w-[20px] self-stretch"
        style={onTabBarMouseDown ? { cursor: 'grab' } : ({ WebkitAppRegion: 'drag' } as React.CSSProperties)}
        onMouseDown={onTabBarMouseDown}
        onContextMenu={onEmptyContextMenu}
      />
    </div>
  )
}
