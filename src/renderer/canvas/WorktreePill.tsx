// =============================================================================
// WorktreePill — the title-bar "worktree chip": shows which parallel branch a
// terminal or agent panel belongs to, color-filled in the worktree's color.
//
//   • Hover  → highlights every node in that worktree (ring + sludge boost).
//   • Click  → menu: focus the worktree on canvas, or switch this panel to
//              another worktree. Switching a TERMINAL opens a fresh PTY in the
//              new checkout (a terminal IS a checkout); switching an AGENT
//              re-tags it and respawns pi in the new checkout (AgentPanel
//              reacts to the changed cwd).
//
// Hidden unless the workspace has 2+ worktrees — otherwise it's just chrome
// noise on the common single-branch flow.
// =============================================================================

import React, { useCallback, useEffect, useState } from 'react'
import { ArrowsSplit } from '@phosphor-icons/react'
import { useAppStore } from '../stores/appStore'
import { useUIStore } from '../stores/uiStore'
import { useWorktrees } from '../stores/useWorktrees'
import { confirmCloseRunningTerminals } from '../lib/confirmCloseTerminal'
import type { PanelState } from '../../shared/types'

interface WorktreePillProps {
  panel: PanelState
  /** Workspace id — passed in so the pill can write through the store. */
  workspaceId: string
}

export const WorktreePill: React.FC<WorktreePillProps> = ({ panel, workspaceId }) => {
  // Live-git facts (branch/isPrimary) joined with persisted UI metadata
  // (color/label), the single source shared with the Parallel Work tab.
  const rootPath = useAppStore((s) => s.workspaces.find((w) => w.id === workspaceId)?.rootPath ?? '')
  const worktrees = useWorktrees(rootPath, workspaceId)
  const setPanelWorktreeId = useAppStore((s) => s.setPanelWorktreeId)
  const setHoveredWorktree = useUIStore((s) => s.setHoveredWorktree)
  const focusWorktree = useUIStore((s) => s.focusWorktree)
  const focusedWorktreeId = useUIStore((s) => s.focusedWorktreeId)

  const current = worktrees.find((w) => w.id === panel.worktreeId) ?? worktrees.find((w) => w.isPrimary)
  const currentId = current?.id

  // Collapsed (icon-only) until hovered, so the overlay covers as little of the
  // panel content as possible (#370); hovering grows it to the full title.
  const [hovered, setHovered] = useState(false)

  const labelOf = (w: { label?: string; branch?: string; isPrimary?: boolean }) =>
    w.label || w.branch || (w.isPrimary ? 'main' : '(detached)')

  // Clear the hover highlight if this chip unmounts while hovered.
  useEffect(() => () => setHoveredWorktree(null), [setHoveredWorktree])

  const handleClick = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!window.electronAPI || !current) return
    const isFocused = focusedWorktreeId === current.id
    const items = [
      { id: '__focus', label: isFocused ? 'Clear focus' : `Focus “${labelOf(current)}” on canvas` },
      { type: 'separator' as const },
      ...worktrees.map((w) => ({
        id: w.id,
        label: labelOf(w) + (w.id === current.id ? '  ✓' : ''),
      })),
    ]
    const choice = await window.electronAPI.showContextMenu(items)
    if (!choice) return

    if (choice === '__focus') {
      focusWorktree(isFocused ? null : current.id)
      return
    }
    if (choice === current.id) return
    const target = worktrees.find((w) => w.id === choice)
    if (!target) return

    if (panel.type === 'terminal') {
      // A terminal is bound to a checkout — switching means a fresh shell in the
      // new path. Warn first if a foreground process is running.
      const ok = await confirmCloseRunningTerminals([panel])
      if (!ok) return
      useAppStore.getState().respawnPanelTerminal(workspaceId, panel.id, target.path, target.id)
    } else {
      // Agent panels: re-tag the panel. AgentPanel derives its cwd from the
      // worktree tag and reacts to the change by disposing the old checkout's
      // chats and reopening pi in the new one, so the agent moves with the pill.
      setPanelWorktreeId(workspaceId, panel.id, target.id)
    }
  }, [worktrees, current, focusedWorktreeId, panel, workspaceId, setPanelWorktreeId, focusWorktree])

  // Only relevant for terminal/agent panels in workspaces with 2+ worktrees.
  if (panel.type !== 'terminal' && panel.type !== 'agent') return null
  if (worktrees.length < 2 || !current) return null

  const isFocused = focusedWorktreeId === currentId

  return (
    <button
      type="button"
      onClick={handleClick}
      onMouseEnter={() => {
        setHovered(true)
        if (currentId) setHoveredWorktree(currentId)
      }}
      onMouseLeave={() => {
        setHovered(false)
        setHoveredWorktree(null)
      }}
      title={`Worktree: ${current.branch || current.path}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: hovered ? 4 : 0,
        height: 18,
        maxWidth: 220,
        padding: hovered ? '0 9px 0 7px' : '0 4px',
        borderRadius: 9,
        // Filled, no outline — the chip IS the worktree color. Slightly toned
        // toward black so white text stays legible across the bright palette.
        backgroundColor: `color-mix(in srgb, ${current.color ?? 'var(--text-muted)'} 92%, black)`,
        border: 'none',
        boxShadow: isFocused ? `0 0 10px -1px ${current.color ?? 'var(--text-muted)'}` : 'none',
        color: '#fff',
        fontSize: 10,
        fontWeight: 600,
        lineHeight: 1,
        letterSpacing: 0.2,
        textShadow: '0 1px 1px rgba(0,0,0,0.3)',
        cursor: 'pointer',
        userSelect: 'none',
        transition:
          'box-shadow 150ms ease, background-color 150ms ease, filter 150ms ease, gap 150ms ease, padding 150ms ease',
        filter: isFocused ? 'brightness(1.12)' : undefined,
      }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <ArrowsSplit size={11} weight="bold" style={{ flexShrink: 0 }} />
      <span
        style={{
          maxWidth: hovered ? 180 : 0,
          opacity: hovered ? 1 : 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          transition: 'max-width 150ms ease, opacity 150ms ease',
        }}
      >
        {labelOf(current)}
      </span>
    </button>
  )
}
