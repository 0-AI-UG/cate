// =============================================================================
// DockTabBar — pure tab-pill row rendering. Renders each tab as a TabPill with
// the active accent, icon, title (or rename input), and close button. Used
// inside DockTabStack's tab bar; the +/split/trailing controls live alongside
// in DockTabStack itself.
// =============================================================================

import React from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { PanelState, PanelType, DockTabStack as DockTabStackType } from '../../shared/types'
import { X } from '@phosphor-icons/react'
import { useDragStore, useTabSourceVisibility } from '../drag'
import { PANEL_REGISTRY, getPanelDef } from '../panels/registry'
import { useAppStore } from '../stores/appStore'
import { useAgentInfoByPanel } from '../hooks/useAgentPanelInfo'
import { worktreeTitleStyle } from '../lib/worktreeTitleStyle'
import { isMiddleClick } from '../lib/mouse'

const AWAIT_COLOR = '#c08a5a'

// Lookup: panelId → worktree color. Only returns a color when the panel's
// workspace has 2+ worktrees (matches WorktreePill's visibility rule, so the
// tab title tint and the title-bar pill appear together or not at all). The
// color is applied to the tab's title text, not its icon — the icon may be an
// agent logo (an <img>, which ignores `color`), and tinting it would clash
// with the per-agent icon swap.
function useWorktreeColorByPanel(): Record<string, string> {
  return useAppStore(useShallow((s) => {
    const out: Record<string, string> = {}
    for (const ws of s.workspaces) {
      const worktrees = ws.worktrees ?? []
      if (worktrees.length < 2) continue
      // isPrimary is a live-git fact, no longer persisted; the primary record is
      // the one keyed by the workspace's own rootPath.
      const primary = worktrees.find((w) => w.path === ws.rootPath)
      for (const panel of Object.values(ws.panels)) {
        if (panel.type !== 'terminal' && panel.type !== 'agent') continue
        const wt = worktrees.find((w) => w.id === panel.worktreeId) ?? primary
        if (wt?.color) out[panel.id] = wt.color
      }
    }
    return out
  }))
}

// Type → icon/tint mirrors the Spotlight overlay so tabs, search results, and
// the command palette speak the same visual language.
export const PANEL_TYPE_TINT: Record<PanelType, string> = Object.fromEntries(
  (Object.keys(PANEL_REGISTRY) as PanelType[]).map((t) => [t, PANEL_REGISTRY[t].tintClass]),
) as Record<PanelType, string>

export function TabIcon({ type, size, logo, agentName }: { type: PanelType; size: number; logo?: string | null; agentName?: string | null }) {
  // Terminal panels with a detected agent CLI swap the generic Terminal
  // icon for the agent's logo. Fallback path stays Phosphor.
  const useLogo = type === 'terminal' ? logo : null
  const [imgFailed, setImgFailed] = React.useState(false)
  // Reset error flag when the logo source actually changes so a once-failed
  // image can recover after an HMR or agent swap.
  React.useEffect(() => { setImgFailed(false) }, [useLogo])
  if (useLogo && !imgFailed) {
    return (
      <img
        src={useLogo}
        alt={agentName ?? ''}
        width={size}
        height={size}
        style={{ width: size, height: size, objectFit: 'contain', display: 'block' }}
        draggable={false}
        onError={() => setImgFailed(true)}
      />
    )
  }
  const Icon = getPanelDef(type).icon
  return <Icon size={size} />
}

/** Thin wrapper around the tab-pill DOM that calls useTabSourceVisibility(panelId)
 *  in its own component scope. */
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
  stack: DockTabStackType
  compact?: boolean
  /** Workspace the tabs belong to — scopes the agent-status lookup. */
  workspaceId?: string
  getPanel: (panelId: string) => PanelState | undefined
  getPanelTitle: (panelId: string) => string
  onClosePanel?: (panelId: string) => void
  onTabClick: (index: number) => void
  onTabMouseDown: (e: React.MouseEvent, panelId: string) => void
  onTabContextMenu: (e: React.MouseEvent, panelId: string) => void
  // Rename state
  renameId: string | null
  renameValue: string
  renameInputRef: React.MutableRefObject<HTMLInputElement | null>
  setRenameValue: (v: string) => void
  setRenameId: (id: string | null) => void
  commitRename: (panelId: string) => void
  beginRename: (panelId: string, currentTitle: string) => void
  // Spring-load on tab hover
  springLoadTimer: React.MutableRefObject<number | null>
  setActiveTab: (stackId: string, index: number) => void
  // Empty-area handlers (host-supplied)
  onEmptyMouseDown?: (e: React.MouseEvent) => void
  onEmptyContextMenu?: (e: React.MouseEvent) => void
  // New-tab drop placeholder
  showTabPlaceholder: boolean
  // When the drag source is THIS stack, hide the dragged tab from layout
  // and inline the placeholder at its original (clamped) index.
  selfTabDrag?: { draggedPanelId: string; originalIndex: number } | null
  // For the trailing draggable spacer in detached windows.
  onTabBarMouseDown?: (e: React.MouseEvent, panelId?: string) => void
}

export function DockTabBar(props: DockTabBarProps) {
  const {
    stack, compact, workspaceId, getPanel, getPanelTitle, onClosePanel,
    onTabClick, onTabMouseDown, onTabContextMenu,
    renameId, renameValue, renameInputRef, setRenameValue, setRenameId, commitRename, beginRename,
    springLoadTimer, setActiveTab,
    onEmptyMouseDown, onEmptyContextMenu,
    showTabPlaceholder, selfTabDrag, onTabBarMouseDown,
  } = props

  const worktreeColorByPanel = useWorktreeColorByPanel()
  const agentInfoByPanel = useAgentInfoByPanel(workspaceId)

  // Build the visible tab list (skip the in-flight tab when source === this
  // stack) and choose where to slot the placeholder. Clamp to >=1 so a
  // leading-tab drag lets the next tab fill index 0 with the placeholder
  // at index 1 (per the requested "tabs always move right" behaviour).
  const remainingPanelIds = selfTabDrag
    ? stack.panelIds.filter((id) => id !== selfTabDrag.draggedPanelId)
    : stack.panelIds
  const placeholderInsertAt = selfTabDrag
    ? Math.min(Math.max(selfTabDrag.originalIndex, 1), remainingPanelIds.length)
    : remainingPanelIds.length

  const placeholderNode = showTabPlaceholder ? (
    <div
      key="__tab-placeholder__"
      aria-hidden
      className={`flex items-center justify-center whitespace-nowrap select-none border-r border-white/5 ${compact ? 'px-2 text-[11px]' : 'px-3 text-xs'}`}
      style={{
        minWidth: 100,
        color: 'var(--focus-blue, #3b82f6)',
        backgroundColor: 'color-mix(in srgb, var(--focus-blue, #3b82f6) 18%, transparent)',
        border: '1px dashed color-mix(in srgb, var(--focus-blue, #3b82f6) 70%, transparent)',
        borderRadius: 4,
      }}
    >
      + new tab
    </div>
  ) : null

  return (
    <div
      className="flex items-stretch flex-1 min-w-0"
      style={onEmptyMouseDown ? { cursor: 'grab' } : undefined}
      onContextMenu={onEmptyContextMenu}
      onMouseDown={(e) => {
        if (e.target !== e.currentTarget) return
        onEmptyMouseDown?.(e)
      }}
    >
      {remainingPanelIds.flatMap((panelId, visIdx) => {
        // Original-index lookup keeps click/active handlers stable when we
        // skip the dragged tab from layout.
        const i = stack.panelIds.indexOf(panelId)
        const isActive = i === stack.activeIndex
        const panel = getPanel(panelId)
        const panelType = (panel?.type ?? 'editor') as PanelType
        const pill = (
          <TabPill
            key={panelId}
            panelId={panelId}
            className={`
              group relative flex items-center gap-1.5 whitespace-nowrap
              cursor-grab select-none min-w-0 shrink max-w-[200px]
              ${compact ? 'pl-2 pr-1.5 text-[11px]' : 'pl-3 pr-2 text-xs'}
              ${isActive ? 'text-secondary font-medium' : 'text-muted hover:text-secondary'}
            `}
            onClick={() => onTabClick(i)}
            onMouseDown={(e) => {
              // Middle button closes the tab on auxclick (below). Suppress the
              // native middle-click autoscroll and don't start a tab drag.
              if (isMiddleClick(e)) { e.preventDefault(); return }
              onTabMouseDown(e, panelId)
            }}
            onAuxClick={(e) => {
              // Middle-click closes the tab — works for both the top dock and
              // canvas-node mini-docks (both render TabPills with onClosePanel).
              // Guarded to the middle button so right-click still opens the menu.
              if (isMiddleClick(e) && onClosePanel) {
                e.preventDefault()
                e.stopPropagation()
                onClosePanel(panelId)
              }
            }}
            onContextMenu={(e) => onTabContextMenu(e, panelId)}
            onPointerEnter={() => {
              if (isActive) return
              if (!useDragStore.getState().isDragging) return
              if (springLoadTimer.current) window.clearTimeout(springLoadTimer.current)
              const delay = panelType === 'canvas' ? 250 : 600
              springLoadTimer.current = window.setTimeout(() => {
                setActiveTab(stack.id, i)
              }, delay)
            }}
            onPointerLeave={() => {
              if (springLoadTimer.current) {
                window.clearTimeout(springLoadTimer.current)
                springLoadTimer.current = null
              }
            }}
            baseStyle={{
              backgroundColor: isActive
                ? 'var(--node-chrome-active-bg, var(--surface-3))'
                : 'var(--node-chrome-bg, var(--surface-1))',
              WebkitAppRegion: 'no-drag',
            } as React.CSSProperties}
            title={getPanelTitle(panelId)}
          >
            <span
              className={`shrink-0 ${isActive ? PANEL_TYPE_TINT[panelType] : 'text-muted'}`}
            >
              <TabIcon
                type={panelType}
                size={compact ? 11 : 13}
                logo={agentInfoByPanel[panelId]?.logo}
                agentName={agentInfoByPanel[panelId]?.name}
              />
            </span>
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
                className="truncate flex-1 min-w-0 bg-transparent outline-none border-b border-blue-500/60 text-primary px-0"
                style={{ font: 'inherit' }}
              />
            ) : (
              <span
                className={`truncate flex-1 min-w-0 ${agentInfoByPanel[panelId]?.state === 'running' ? 'cate-notif-pulse' : ''}`}
                style={worktreeTitleStyle(worktreeColorByPanel[panelId], agentInfoByPanel[panelId]?.state === 'running')}
              >{getPanelTitle(panelId)}</span>
            )}
            {agentInfoByPanel[panelId]?.state === 'waitingForInput' && (
              <span className="cate-await-indicator shrink-0" aria-label="awaiting input">
                <span className="cate-await-dot" style={{ backgroundColor: AWAIT_COLOR }} />
              </span>
            )}
            {onClosePanel && (
              <span
                className={`shrink-0 p-0.5 rounded-sm hover:bg-hover cursor-pointer ${
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
          </TabPill>
        )
        // Inline the placeholder right before the tab that now occupies the
        // dragged tab's original slot (clamped). When the slot is at the end
        // we append it after the last tab below.
        if (placeholderNode && visIdx === placeholderInsertAt) {
          return [placeholderNode, pill]
        }
        return [pill]
      })}
      {placeholderNode && placeholderInsertAt >= remainingPanelIds.length && placeholderNode}
      {/* Draggable spacer that fills the rest of the row. */}
      <div
        className="flex-1 min-w-[20px] self-stretch"
        style={
          onTabBarMouseDown
            ? { cursor: 'grab' }
            : ({ WebkitAppRegion: 'drag' } as React.CSSProperties)
        }
        onMouseDown={onTabBarMouseDown}
        onContextMenu={onEmptyContextMenu}
      />
    </div>
  )
}
