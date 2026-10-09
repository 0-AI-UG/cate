// What sidebar rows, dock tabs and panel titles show about the agent a panel
// hosts: its status, name and logo.

import { AGENTS, type AgentId, type AgentPanelStates, type AgentStatus, type PanelAgentState } from '@services/agents/contract'
import { openAgentOf } from '@services/agents/client'
import { agentLogo } from './logos'

export interface AgentPanelInfo {
  status: AgentStatus
  /** The agent's label, or null once a terminal's agent exited. */
  name: string | null
  /** Logo URL for the agent, or null (a chat then shows the T3 logo). */
  logo: string | null
  /** The agent stands in for its panel (see `PanelAgentState`). */
  takesOverPanel: boolean
}

export function agentPanelInfo(state: PanelAgentState): AgentPanelInfo {
  // Name and logo go with the label, so the icon reverts to the panel's once
  // the agent is gone; the status stays so finished and awaiting indicators
  // still show.
  return {
    status: state.status,
    name: state.label,
    logo: state.label ? agentLogo(state.agentId) : null,
    takesOverPanel: state.takesOverPanel,
  }
}

export function agentInfoByPanel(states: AgentPanelStates): Record<string, AgentPanelInfo> {
  const out: Record<string, AgentPanelInfo> = {}
  for (const [panelId, state] of Object.entries(states)) out[panelId] = agentPanelInfo(state)
  return out
}

export function agentInfoEqual(a: AgentPanelInfo | undefined, b: AgentPanelInfo | undefined): boolean {
  if (!a || !b) return a === b
  return a.status === b.status && a.takesOverPanel === b.takesOverPanel && a.name === b.name && a.logo === b.logo
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

/** `agentPanelTitle` over the info a tab or sidebar row already holds: an
 *  agent that stands in for its panel names it only while it runs. */
export function agentInfoTitle(title: string, info: AgentPanelInfo | undefined): string {
  return info?.takesOverPanel && info.name && isAgentFallbackTitle(title) ? info.name : title
}
