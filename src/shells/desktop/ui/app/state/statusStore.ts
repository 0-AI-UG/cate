// Terminal activity of each open workspace, as the sidebar shows it. The
// store is the terminal client's; agent states come from services/agents/ui.

import { useSyncExternalStore } from 'react'
import { subscribeTerminalStatuses, terminalStatuses } from '@services/terminal/client'
import type { TerminalStatuses } from '@services/terminal/contract'

const EMPTY: TerminalStatuses = {}
const noop = () => () => {}

export function useTerminalStatuses(workspaceId: string | null | undefined): TerminalStatuses {
  return useSyncExternalStore(
    workspaceId ? (l) => subscribeTerminalStatuses(workspaceId, l) : noop,
    () => (workspaceId ? terminalStatuses(workspaceId) : EMPTY),
  )
}
