// Closing a terminal with a running program asks first (architecture 11.2
// rule 6). The client's close path runs this guard; `cate.panel.close` gets
// the session's `dirty` instead and passes `discard` itself.

import type { SessionHandle } from '@client/connections'
import type { CloseGuard } from '@client/host'
import { clientUi } from '@kernel/ui'
import type { TerminalSnapshot } from '../contract/types'

const FIRST_SNAPSHOT_MS = 2000

declare module '@kernel/ui/contract' {
  interface ClientUi {
    confirmCloseTerminal(request: { count: number; processName?: string | null }): Promise<'close' | 'cancel'>
    /** Where a clicked terminal link opens; the answer is remembered. */
    promptLinkOpen(url: string): Promise<'canvas' | 'external' | 'cancel'>
  }
}

/** The program that makes closing this terminal destructive, if any. */
export function runningProcess(snapshot: TerminalSnapshot | null): string | null | undefined {
  if (!snapshot || snapshot.status !== 'running' || snapshot.activity.type !== 'running') return undefined
  return snapshot.activity.processName || null
}

/** True when the terminals may close: none runs a program, or the person
 *  chose to close anyway. */
export async function confirmCloseTerminals(snapshots: readonly (TerminalSnapshot | null)[]): Promise<boolean> {
  const running = snapshots.map(runningProcess).filter((name): name is string | null => name !== undefined)
  if (running.length === 0) return true
  const processName = running.length === 1 ? running[0] : null
  return (await clientUi().confirmCloseTerminal({ count: running.length, processName })) === 'close'
}

/** The session's snapshot, waiting briefly for the first one of a channel
 *  opened just for the close. */
function snapshotOf(session: SessionHandle | null): Promise<TerminalSnapshot | null> {
  if (!session) return Promise.resolve(null)
  const current = session.getSnapshot() as { snapshot: TerminalSnapshot } | null
  if (current) return Promise.resolve(current.snapshot)
  return new Promise((resolve) => {
    const done = (value: TerminalSnapshot | null) => {
      clearTimeout(timer)
      off()
      resolve(value)
    }
    const timer = setTimeout(() => done(null), FIRST_SNAPSHOT_MS)
    const off = session.subscribe(() => {
      const state = session.getSnapshot() as { snapshot: TerminalSnapshot } | null
      if (state) done(state.snapshot)
    })
  })
}

export const terminalCloseGuard: CloseGuard = async ({ session }) =>
  confirmCloseTerminals([await snapshotOf(session)])
