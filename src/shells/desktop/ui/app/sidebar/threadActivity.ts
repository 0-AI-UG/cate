import type { PanelRecord } from '@workspace/document/contract'
import type { PanelAgentState } from '@services/agents/contract'
import type { TerminalStatus } from '@services/terminal/contract'

export type ThreadPhase = 'blocked' | 'ready' | 'running' | 'unknown' | 'settled'

export function threadKey(workspaceId: string, panelId: string): string {
  return JSON.stringify([workspaceId, panelId])
}

/** Only agent hooks prove a blocking human prompt. Shell activity can prove
 *  that a command stopped, but cannot identify arbitrary TUI questions. */
export function threadActivity(agent: PanelAgentState | undefined, terminal: TerminalStatus | undefined, ran: boolean): { phase: ThreadPhase; label: string } | null {
  if (agent?.status === 'running') return { phase: 'running', label: 'Working' }
  if (agent?.status === 'waitingForInput') return agent.canReceivePrompt
    ? { phase: 'ready', label: 'Ready for your next prompt' }
    : { phase: 'blocked', label: 'Needs your response' }
  if (agent?.status === 'finished') return { phase: 'settled', label: 'Agent exited' }
  if (agent?.present) return { phase: 'unknown', label: agent.hooksMissing ? 'Hooks off' : agent.hooksNeedApproval ? 'Hooks need approval' : 'Status unavailable' }
  if (!terminal) return null
  if (!terminal.alive) return { phase: 'settled', label: terminal.exitCode ? `Exited with code ${terminal.exitCode}` : 'Finished' }
  if (terminal.suspended) return { phase: 'settled', label: 'Suspended' }
  if (terminal.activity.type === 'running') return { phase: 'running', label: terminal.activity.processName || 'Running' }
  return ran ? { phase: 'ready', label: 'Command finished' } : { phase: 'settled', label: 'Terminal idle' }
}

export interface SidebarThread {
  key: string
  workspaceId: string
  workspaceName: string
  panel: PanelRecord
  title: string
  agentId: PanelAgentState['agentId']
  agentName?: string | null
  machineName?: string
  completedAt?: number
  phase: ThreadPhase
  label: string
  focused?: boolean
}

export function threadAge(at: number | undefined, now: number): string {
  if (at === undefined || !Number.isFinite(at)) return '–'
  const minutes = Math.floor(Math.max(0, now - at) / 60_000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  if (minutes < 1_440) return `${Math.floor(minutes / 60)}h`
  return `${Math.floor(minutes / 1_440)}d`
}

export function groupThreads(threads: readonly SidebarThread[], settled: readonly string[]): { attention: SidebarThread[]; working: SidebarThread[]; unknown: SidebarThread[]; done: SidebarThread[] } {
  const acknowledged = new Set(settled)
  const attention: SidebarThread[] = []
  const working: SidebarThread[] = []
  const unknown: SidebarThread[] = []
  const done: SidebarThread[] = []
  for (const thread of threads) {
    if (thread.phase === 'settled' || (thread.phase === 'ready' && acknowledged.has(thread.key))) done.push(thread)
    else if (thread.phase === 'blocked' || thread.phase === 'ready') attention.push(thread)
    else if (thread.phase === 'unknown') unknown.push(thread)
    else working.push(thread)
  }
  attention.sort((a, b) => Number(b.phase === 'blocked') - Number(a.phase === 'blocked'))
  return { attention, working, unknown, done }
}
