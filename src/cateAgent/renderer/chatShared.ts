// =============================================================================
// chatShared — small helpers shared across the agent chat message components
// (ChatThread, ChatMessageRow, ChatToolCard, ChatSubagentCard, …). Kept
// dependency-light so any chat component can import without cycles.
// =============================================================================

import {
  Wrench,
  PencilSimple,
  Terminal as TerminalIcon,
  FileText,
  MagnifyingGlass,
} from '@phosphor-icons/react'

/** Tool names we render as file edits (diff/preview) rather than generic args. */
export const EDIT_NAMES: ReadonlySet<string> = new Set([
  'edit', 'write', 'multi_edit', 'multiedit', 'multiEdit', 'MultiEdit',
  'str_replace', 'str_replace_based_edit_tool', 'str_replace_editor',
  'apply_patch', 'edit_file', 'editFile',
])

export function toolIcon(name: string) {
  if (name === 'bash' || name === 'shell') return TerminalIcon
  if (EDIT_NAMES.has(name)) return PencilSimple
  if (name === 'read' || name === 'view') return FileText
  if (name === 'grep' || name === 'search') return MagnifyingGlass
  return Wrench
}

export function prettyArgs(args: unknown): string {
  try {
    return typeof args === 'string' ? args : JSON.stringify(args, null, 2)
  } catch {
    return String(args)
  }
}

export function formatTokensShort(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}

export function formatTime(ms: number): string {
  try {
    return new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  } catch {
    return ''
  }
}
