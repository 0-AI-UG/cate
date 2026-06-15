// =============================================================================
// CateAgentWorktreeSelect — a minimal worktree picker for the Cate Agent input
// bar. Unlike the toolbar's WorktreeToolbarMenu (statuses, per-row actions,
// create), this is select-only: it shows the chosen target as a small tag (color
// dot + title) and opens a plain list to pick where the next prompt runs:
//   'new'  → a fresh isolated worktree per job (default)
//   'root' → no worktree, straight in the project root
//   <id>   → an existing worktree
// =============================================================================

import React from 'react'
import { createPortal } from 'react-dom'
import { Check, ArrowsSplit } from '@phosphor-icons/react'
import { useAppStore } from '../stores/appStore'
import type { WorktreeMeta } from '../../shared/types'

/** Where a prompt runs: new isolated worktree, no worktree (root), or an id. */
export type WorktreeTarget = 'new' | 'root' | string
const ACCENT = 'rgb(var(--agent-rgb))'
const MUTED = 'var(--surface-5)'
const wtTitle = (wt: WorktreeMeta): string => wt.label || wt.path.split(/[/\\]/).pop() || 'worktree'

export const CateAgentWorktreeSelect: React.FC<{
  workspaceId: string
  value: WorktreeTarget
  onChange: (target: WorktreeTarget) => void
}> = ({ workspaceId, value, onChange }) => {
  const worktrees = useAppStore((s) => s.workspaces.find((w) => w.id === workspaceId)?.worktrees) ?? []
  const [open, setOpen] = React.useState(false)
  const btnRef = React.useRef<HTMLButtonElement>(null)
  const menuRef = React.useRef<HTMLDivElement>(null)
  const [pos, setPos] = React.useState<{ left: number; bottom: number } | null>(null)

  const selectedWt = value !== 'new' && value !== 'root' ? worktrees.find((w) => w.id === value) ?? null : null
  const title = selectedWt ? wtTitle(selectedWt) : value === 'root' ? 'No worktree' : 'New worktree'
  const dot = selectedWt?.color ?? (value === 'root' ? MUTED : ACCENT)

  React.useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (!btnRef.current?.contains(t) && !menuRef.current?.contains(t)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])

  const toggle = () => {
    const r = btnRef.current?.getBoundingClientRect()
    if (r) setPos({ left: r.left, bottom: window.innerHeight - r.top + 6 })
    setOpen((v) => !v)
  }

  const pick = (target: WorktreeTarget) => {
    onChange(target)
    setOpen(false)
  }

  return (
    <>
      {/* Worktree pill — same size/position as before, with the worktree-fork
          icon and title, tinted in the worktree color. */}
      <button
        ref={btnRef}
        type="button"
        onClick={toggle}
        aria-label={`Run in worktree: ${title}`}
        style={{
          WebkitTapHighlightColor: 'transparent',
          backgroundColor: `color-mix(in srgb, ${dot} 20%, transparent)`,
          border: `1px solid color-mix(in srgb, ${dot} 45%, transparent)`,
        }}
        className="flex-shrink-0 inline-flex items-center gap-1.5 max-w-[160px] rounded-full px-2 py-1 text-xs text-secondary"
      >
        <ArrowsSplit size={12} weight="bold" className="flex-shrink-0" style={{ color: dot }} />
        <span className="truncate">{title}</span>
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={menuRef}
            className="fixed z-[2147483000] min-w-[180px] max-w-[260px] rounded-xl border border-subtle bg-surface-1 shadow-[0_8px_24px_-6px_var(--shadow-node)] py-1"
            style={{ left: pos.left, bottom: pos.bottom }}
          >
            <Row label="New worktree" color={ACCENT} selected={value === 'new'} onClick={() => pick('new')} />
            <Row label="No worktree" color={MUTED} selected={value === 'root'} onClick={() => pick('root')} />
            {worktrees.map((wt) => (
              <Row key={wt.id} label={wtTitle(wt)} color={wt.color} selected={value === wt.id} onClick={() => pick(wt.id)} />
            ))}
          </div>,
          document.body,
        )}
    </>
  )
}

const Row: React.FC<{ label: string; color: string; selected: boolean; onClick: () => void }> = ({
  label,
  color,
  selected,
  onClick,
}) => (
  <button
    type="button"
    onClick={onClick}
    className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-secondary hover:text-primary hover:bg-hover transition-colors text-left"
  >
    <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: color }} />
    <span className="flex-1 min-w-0 truncate">{label}</span>
    {selected && <Check size={12} weight="bold" className="flex-shrink-0 text-primary" />}
  </button>
)
