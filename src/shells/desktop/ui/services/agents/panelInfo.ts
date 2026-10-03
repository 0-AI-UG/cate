// What sidebar rows, dock tabs and panel titles show about the agent a panel
// hosts: its status, name and logo.

import { AGENTS, type AgentId, type AgentPanelStates, type AgentRunner, type AgentStatus, type PanelAgentState } from '@services/agents/contract'
import { openAgentOf } from '@services/agents/client'
import { agentLogo } from './logos'

export interface AgentPanelInfo {
  status: AgentStatus
  runner: AgentRunner
  /** Agent display name, or null once a terminal's agent exited. */
  name: string | null
  /** Logo URL for the agent, or null (a t3 panel then shows the T3 logo). */
  logo: string | null
}

export function agentPanelInfo(state: PanelAgentState): AgentPanelInfo {
  if (state.runner === 't3') {
    const name = state.agentName ?? 'T3 Code'
    return {
      status: state.status,
      runner: 't3',
      name: state.present ? name : `${name} (disconnected)`,
      logo: agentLogo(state.agentId),
    }
  }
  // The agent id outlives the process. Gate name and logo on presence so the
  // icon reverts to the terminal glyph once the CLI is gone; the status stays
  // so finished and awaiting indicators still show.
  const open = openAgentOf(state)
  return {
    status: state.status,
    runner: 'terminal',
    name: open ? state.agentName : null,
    logo: agentLogo(open),
  }
}

export function agentInfoByPanel(states: AgentPanelStates): Record<string, AgentPanelInfo> {
  const out: Record<string, AgentPanelInfo> = {}
  for (const [panelId, state] of Object.entries(states)) out[panelId] = agentPanelInfo(state)
  return out
}

export function agentInfoEqual(a: AgentPanelInfo | undefined, b: AgentPanelInfo | undefined): boolean {
  if (!a || !b) return a === b
  return a.status === b.status && a.runner === b.runner && a.name === b.name && a.logo === b.logo
}

export function recordEqual<T>(a: Record<string, T>, b: Record<string, T>, eq: (x: T, y: T) => boolean = Object.is): boolean {
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every((key) => key in b && eq(a[key], b[key]))
}

/** Cate's generic labels (a numbered "Terminal", an agent's name). A panel
 *  titled this way shows the open agent's name instead; a real title wins. */
export function isAgentFallbackTitle(title: string): boolean {
  return /^Terminal(?: \d+)?$/.test(title) || AGENTS.some((agent) => agent.displayName === title)
}

/** The title to show for a panel: the agent's name while an agent is open
 *  and the record carries only a fallback title. */
export function agentPanelTitle(title: string, state: PanelAgentState | undefined): string {
  const open: AgentId | null = openAgentOf(state)
  if (!open || !state?.agentName || !isAgentFallbackTitle(title)) return title
  return state.agentName
}
