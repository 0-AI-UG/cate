import { useState } from 'react'
import { GitFork } from 'lucide-react'
import type { JoinedWorktree } from '../stores/useWorktrees'

export function worktreeLabel(worktree: JoinedWorktree): string {
  return worktree.label || worktree.branch || (worktree.isPrimary ? 'main' : '(detached)')
}

interface WorktreeSelectorProps {
  worktrees: JoinedWorktree[]
  value?: string
  onChange: (worktreeId: string) => void | Promise<void>
  title: string
  prefix?: string
  /** Overlay selectors reveal their label on hover, focus, or while the menu is open. */
  overlay?: boolean
  disabled?: boolean
  focused?: boolean
  onHoverChange?: (worktreeId: string | null) => void
  focusAction?: { label: string; onSelect: () => void }
}

export function WorktreeSelector({ worktrees, value, onChange, title, prefix, overlay = false, disabled = false, focused = false, onHoverChange, focusAction }: WorktreeSelectorProps) {
  const [hovered, setHovered] = useState(false)
  const [keyboardFocused, setKeyboardFocused] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const live = worktrees.filter((worktree) => !worktree.isOrphan)
  const current = live.find((worktree) => worktree.id === value)
    ?? live.find((worktree) => worktree.isPrimary)
    ?? live[0]
  if (live.length < 2 || !current) return null

  const expanded = !overlay || hovered || keyboardFocused || menuOpen
  const color = current.color || 'var(--text-muted)'
  const openMenu = async () => {
    if (menuOpen || disabled) return
    setMenuOpen(true)
    try {
      const choice = await window.electronAPI.showContextMenu([
        ...(focusAction ? [{ id: '__focus', label: focusAction.label }, { type: 'separator' as const }] : []),
        ...live.map((worktree) => ({ id: worktree.id, label: worktreeLabel(worktree) + (worktree.id === current.id ? '  ✓' : '') })),
      ])
      if (choice === '__focus' && focusAction) focusAction.onSelect()
      else if (choice && choice !== current.id && live.some((worktree) => worktree.id === choice)) await onChange(choice)
    } finally {
      setMenuOpen(false)
    }
  }

  return <button
    type="button"
    aria-label={title}
    aria-haspopup="menu"
    aria-expanded={menuOpen}
    disabled={disabled}
    title={`${title}: ${worktreeLabel(current)}`}
    className="min-w-0 max-w-full focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:opacity-40"
    onClick={(event) => { event.stopPropagation(); void openMenu() }}
    onMouseDown={(event) => event.stopPropagation()}
    onMouseEnter={() => { setHovered(true); onHoverChange?.(current.id) }}
    onMouseLeave={() => { setHovered(false); onHoverChange?.(null) }}
    onFocus={(event) => setKeyboardFocused(event.currentTarget.matches(':focus-visible'))}
    onBlur={() => setKeyboardFocused(false)}
    style={{
      display: 'inline-flex', alignItems: 'center', gap: expanded ? 4 : 0,
      height: 18, padding: expanded ? '0 9px 0 7px' : '0 4px', borderRadius: 999,
      backgroundColor: `color-mix(in srgb, ${color} 92%, black)`, border: 'none',
      boxShadow: focused ? `0 0 10px -1px ${color}` : 'none',
      color: '#fff', fontSize: 10, fontWeight: 600, lineHeight: 1, letterSpacing: 0.2,
      textShadow: '0 1px 1px rgba(0,0,0,0.3)', cursor: disabled ? 'default' : 'pointer', userSelect: 'none',
      transition: 'box-shadow 150ms ease, background-color 150ms ease, filter 150ms ease, gap 150ms ease, padding 150ms ease',
      filter: focused ? 'brightness(1.12)' : undefined,
    }}
  >
    <GitFork size={11} className="shrink-0" />
    <span style={{ maxWidth: expanded ? 180 : 0, opacity: expanded ? 1 : 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', transition: 'max-width 150ms ease, opacity 150ms ease' }}>
      {prefix ? `${prefix} ` : ''}{worktreeLabel(current)}
    </span>
  </button>
}
