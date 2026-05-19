// =============================================================================
// ShortcutHintOverlay — Floating hint badges shown when Cmd is held for 750ms.
// Ported from ShortcutHintToolbarOverlay + ShortcutHintGlobalOverlay in Swift.
// =============================================================================

import React, { useMemo } from 'react'
import { useShortcutStore } from '../stores/shortcutStore'
import { ShortcutHintBadge } from './ShortcutHintBadge'
import type { ShortcutAction, StoredShortcut } from '../../shared/types'
import { SHORTCUT_DISPLAY_NAMES } from '../../shared/types'

// -----------------------------------------------------------------------------
// Hint entry
// -----------------------------------------------------------------------------

interface HintEntry {
  action: ShortcutAction
  badgeLabel: string
  displayName: string
}

/**
 * Format a shortcut's badge text.
 * The command symbol is rendered separately in the badge component,
 * so we only include control/option/shift modifiers and the key.
 */
function formatBadgeLabel(shortcut: StoredShortcut): string {
  let prefix = ''
  if (shortcut.control) prefix += '\u2303'  // ⌃
  if (shortcut.option) prefix += '\u2325'   // ⌥
  if (shortcut.shift) prefix += '\u21E7'    // ⇧

  let displayKey: string
  switch (shortcut.key) {
    case '\t':
      displayKey = 'Tab'
      break
    case '\\':
      displayKey = '\\'
      break
    case '=':
      displayKey = '='
      break
    case '-':
      displayKey = '-'
      break
    case ' ':
      displayKey = 'Space'
      break
    default:
      displayKey = shortcut.key.toUpperCase()
      break
  }

  return prefix + displayKey
}

/**
 * Check if a shortcut's modifier combo matches the currently active modifiers.
 */
function matchesActiveModifiers(
  shortcut: StoredShortcut,
  active: { command: boolean; shift: boolean; option: boolean; control: boolean },
): boolean {
  return (
    shortcut.command === active.command &&
    shortcut.shift === active.shift &&
    shortcut.option === active.option &&
    shortcut.control === active.control
  )
}

// -----------------------------------------------------------------------------
// Component
// -----------------------------------------------------------------------------

export const ShortcutHintOverlay: React.FC = () => {
  const isShowingHints = useShortcutStore((s) => s.isShowingHints)
  const activeModifiers = useShortcutStore((s) => s.activeModifiers)
  const shortcuts = useShortcutStore((s) => s.shortcuts)

  const globalHints: HintEntry[] = useMemo(() => {
    if (!isShowingHints) return []

    const entries: HintEntry[] = []

    for (const [action, shortcut] of Object.entries(shortcuts) as [ShortcutAction, StoredShortcut][]) {
      // Only show shortcuts whose modifiers match what is currently held
      if (!matchesActiveModifiers(shortcut, activeModifiers)) continue

      entries.push({
        action,
        badgeLabel: formatBadgeLabel(shortcut),
        displayName: SHORTCUT_DISPLAY_NAMES[action],
      })
    }

    return entries
  }, [isShowingHints, activeModifiers, shortcuts])

  if (!isShowingHints || globalHints.length === 0) return null

  return (
    <div
      className="fixed z-[60] pointer-events-none animate-in fade-in slide-in-from-bottom-1 duration-150"
      style={{
        // Sit above the minimap toggle (bottom-4 + ~44px button + gap).
        bottom: 'calc(1rem + 44px + 0.5rem)',
        right: 'calc(1rem + var(--cate-right-sidebar-width, 0px))',
      }}
    >
      <div
        className="flex flex-col gap-1 items-stretch rounded-xl border border-subtle p-2 shadow-[0_18px_40px_-12px_var(--shadow-node)]"
        style={{
          backgroundColor: 'color-mix(in srgb, var(--surface-6) 92%, transparent)',
          backdropFilter: 'blur(8px) saturate(0.9)',
          WebkitBackdropFilter: 'blur(8px) saturate(0.9)',
          minWidth: 180,
        }}
      >
        {globalHints.map((hint) => (
          <div
            key={hint.action}
            className="flex items-center justify-between gap-3 pl-1.5"
          >
            <span className="text-[11px] text-secondary truncate">{hint.displayName}</span>
            <ShortcutHintBadge label={hint.badgeLabel} />
          </div>
        ))}
      </div>
    </div>
  )
}

// Re-export ShortcutHintBadge for use in CanvasToolbar
export { ShortcutHintBadge } from './ShortcutHintBadge'
