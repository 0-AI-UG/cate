// =============================================================================
// CateAgentWorktreeSelect — a minimal worktree picker for the Cate Agent input
// bar. Select-only (no statuses / per-row actions / create). Collapsed it's just
// the worktree-fork icon tinted in the target's color; on hover (or while open)
// it expands to reveal the name. Picks where the next prompt runs:
//   'new'  → a fresh isolated worktree per job (default)
//   'root' → the primary checkout, no worktree
//   <id>   → an existing worktree
// The full live worktree list comes from useWorktrees (same source as the
// toolbar's worktree menu), so existing worktrees are selectable.
// =============================================================================

import React from 'react'
import { createPortal } from 'react-dom'
import { Check, ArrowsSplit } from '@phosphor-icons/react'
import { useWorktrees, type JoinedWorktree } from '../stores/useWorktrees'

export type WorktreeTarget = 'new' | 'root' | string
const ACCENT = 'rgb(var(--agent-rgb))'
const MUTED = 'var(--surface-5)'
const wtTitle = (wt: JoinedWorktree): string => wt.label || wt.branch || wt.path.split(/[/\\]/).pop() || 'worktree'

export const CateAgentWorktreeSelect: React.FC<{
  workspaceId: string
  rootPath: string
  value: WorktreeTarget
  onChange: (target: WorktreeTarget) => void
}> = ({ workspaceId, rootPath, value, onChange }) => {
  const worktrees = useWorktrees(rootPath, workspaceId)
  const primary = worktrees.find((w) => w.isPrimary)
  const others = worktrees.filter((w) => !w.isPrimary)

  const [open, setOpen] = React.useState(false)
  const [hovered, setHovered] = React.useState(false)
  const btnRef = React.useRef<HTMLButtonElement>(null)
  const menuRef = React.useRef<HTMLDivElement>(null)
  const [pos, setPos] = React.useState<{ left: number; bottom: number } | null>(null)

  const selectedWt = value !== 'new' && value !== 'root' ? others.find((w) => w.id === value) ?? null : null
  const title = selectedWt
    ? wtTitle(selectedWt)
    : value === 'root'
      ? primary
        ? wtTitle(primary)
        : 'No worktree'
      : 'New worktree'
  const color = selectedWt?.color ?? (value === 'root' ? primary?.color ?? MUTED : ACCENT)
  const expanded = hovered || open

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
  const pick = (t: WorktreeTarget) => {
    onChange(t)
    setOpen(false)
  }

  return (
    <>
      {/* Worktree-color circle (icon only); on hover/open it grows rightward to
          reveal the name. Height is fixed and the icon stays pinned left, so only
          the padding/gap + the name's width animate — no layout thrash. */}
      <button
        ref={btnRef}
        type="button"
        onClick={toggle}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        aria-label={`Run in worktree: ${title}`}
        style={{
          WebkitTapHighlightColor: 'transparent',
          backgroundColor: `color-mix(in srgb, ${color} 20%, transparent)`,
          border: `1px solid color-mix(in srgb, ${color} 45%, transparent)`,
          height: 28,
          gap: expanded ? 6 : 0,
          padding: expanded ? '0 11px 0 8px' : '0 7px',
          transition: 'gap 160ms ease, padding 160ms ease',
        }}
        className="flex-shrink-0 inline-flex items-center rounded-full text-xs text-secondary overflow-hidden"
      >
        <ArrowsSplit size={13} weight="bold" style={{ color, flexShrink: 0 }} />
        <span
          className="truncate"
          style={{
            maxWidth: expanded ? 150 : 0,
            opacity: expanded ? 1 : 0,
            transition: 'max-width 160ms ease, opacity 160ms ease',
          }}
        >
          {title}
        </span>
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={menuRef}
            className="fixed z-[2147483000] min-w-[200px] max-w-[280px] rounded-xl border border-subtle bg-surface-1 shadow-[0_8px_24px_-6px_var(--shadow-node)] py-1"
            style={{ left: pos.left, bottom: pos.bottom }}
          >
            <Row label="New worktree" color={ACCENT} selected={value === 'new'} onClick={() => pick('new')} />
            <Row
              label={primary ? `${wtTitle(primary)} (no worktree)` : 'No worktree'}
              color={primary?.color ?? MUTED}
              selected={value === 'root'}
              onClick={() => pick('root')}
            />
            {others.map((wt) => (
              <Row key={wt.id} label={wtTitle(wt)} color={wt.color ?? MUTED} selected={value === wt.id} onClick={() => pick(wt.id)} />
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
