// A worktree chip that opens a menu of the live worktrees to pick one.

import { useEffect, useRef, useState } from 'react'
import { GitFork } from 'lucide-react'
import { clientUi } from '@kernel/interaction'
import type { JoinedWorktree } from '@workspace/repository/contract'
import { useTheme, worktreeColor } from './colors'
import { worktreeLabel } from './worktrees'

const LABEL_MAX = 180
/** Icon, gap and padding of the expanded chip. */
const CHIP_CHROME = 31
const ROOM_RESERVE = 240

interface WorktreeSelectorProps {
  worktrees: JoinedWorktree[]
  value?: string
  onChange: (worktreeId: string) => void | Promise<void>
  title: string
  prefix?: string
  /** Overlay selectors reveal their label on hover, focus, or while the menu is open.
   *  Any selector stays icon-only while its room (the nearest
   *  `[data-worktree-room]` ancestor, else its parent) is too narrow. */
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
  const [roomy, setRoomy] = useState(true)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const labelRef = useRef<HTMLSpanElement>(null)
  const theme = useTheme()
  const live = worktrees.filter((worktree) => !worktree.isOrphan)
  const current = live.find((worktree) => worktree.id === value)
    ?? live.find((worktree) => worktree.isPrimary)
    ?? live[0]
  const label = current ? `${prefix ? `${prefix} ` : ''}${worktreeLabel(current)}` : ''

  // The label shows only when the room keeps ROOM_RESERVE px free beside the
  // expanded chip, so the chip never crowds the content it sits on.
  useEffect(() => {
    const button = buttonRef.current
    const room = button?.closest<HTMLElement>('[data-worktree-room]') ?? button?.parentElement
    if (!room || typeof ResizeObserver === 'undefined') return
    const update = () => {
      const chip = CHIP_CHROME + Math.min(LABEL_MAX, labelRef.current?.scrollWidth ?? 0)
      setRoomy(room.clientWidth >= chip + ROOM_RESERVE)
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(room)
    return () => observer.disconnect()
  }, [label, live.length])

  if (live.length < 2 || !current) return null

  const expanded = roomy && (!overlay || hovered || keyboardFocused || menuOpen)
  const color = worktreeColor(current.color, theme) || 'var(--text-muted)'
  const openMenu = async () => {
    const ui = clientUi()
    if (menuOpen || disabled || !ui.showContextMenu) return
    setMenuOpen(true)
    try {
      const choice = await ui.showContextMenu([
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
    ref={buttonRef}
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
    <span ref={labelRef} style={{ maxWidth: expanded ? LABEL_MAX : 0, opacity: expanded ? 1 : 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', transition: 'max-width 150ms ease, opacity 150ms ease' }}>
      {label}
    </span>
  </button>
}
