// services/terminal contract: the `process` capability (PTYs, their shared
// screens and status) and the terminal settings slices. Pure.

import type { TerminalStatuses, TerminalStatusChange } from './contract/capability'

export * from './contract/capability'
export * from './contract/settings'

/** Applies a status change to a mirrored status map. */
export function applyStatusChange(statuses: TerminalStatuses, change: TerminalStatusChange): TerminalStatuses {
  const next = { ...statuses }
  for (const [id, status] of Object.entries(change)) {
    if (status) next[id] = status
    else delete next[id]
  }
  return next
}
