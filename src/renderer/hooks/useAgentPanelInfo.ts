import { t3PanelActivity, t3PanelConnected, t3ThreadForPanel, useT3ActivityStore } from '../stores/t3ActivityStore'
import t3Logo from '../assets/t3-code.svg?url'
// Per-panel agent status (state + name + logo) for the sidebar tree and dock
// tabs. Owns the two bits of glue both consumers used to re-derive by hand:
//   1. the ptyId→panelId translation (status is keyed by ptyId, tabs by panelId)
//   2. the `agentPresent` gate on the name/logo
// so the invariant lives in one place instead of being copied per consumer.

import { useStoreWithEqualityFn } from 'zustand/traditional'
import { useStatusStore, type StatusStore } from '../stores/statusStore'
import { terminalRegistry } from '../lib/terminal/terminalRegistry'
import { getAgentLogoById } from '../lib/agent/agentLogos'
import { terminalAgent } from '../lib/agent/terminalAgent'
import type { AgentState } from '../../shared/types'
import { AGENTS, agentIdForT3Provider, matchAgentDef, type AgentId } from '../../shared/agents'

export interface AgentPanelInfo {
  state: AgentState | undefined
  /** Agent display name, or null once the process has exited. */
  name: string | null
  /** Logo asset URL for `name`, or null when unknown / no agent. */
  logo: string | null
}

/** Status is keyed by ptyId; tabs and tree rows are keyed by panelId. Agent
 *  panels register state directly by panelId, so fall back to the raw key. */
function resolvePanelId(key: string): string {
  return terminalRegistry.panelIdForPty(key) ?? key
}

export function selectAgentInfoByPanel(
  s: StatusStore,
  workspaceId: string | undefined,
): Record<string, AgentPanelInfo> {
  const out: Record<string, AgentPanelInfo> = {}
  const ws = workspaceId ? s.workspaces[workspaceId] : undefined
  if (!ws) return out
  for (const [key, terminal] of Object.entries(ws.terminals)) {
    // `agentName` is kept populated after the agent exits so the status
    // footer can still read "Finished (Claude Code)". Gate the name/logo on
    // `agentPresent` so the icon reverts to the terminal glyph the moment
    // the process is gone; leave `state` ungated so the finished/awaiting
    // indicators still render.
    const agent = terminalAgent(terminal)
    out[resolvePanelId(key)] = {
      state: terminal.agentState,
      name: agent?.displayName ?? null,
      logo: getAgentLogoById(agent?.id),
    }
  }
  return out
}

function agentInfoMapEqual(
  a: Record<string, AgentPanelInfo>,
  b: Record<string, AgentPanelInfo>,
): boolean {
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  for (const k of keys) {
    const x = a[k]
    const y = b[k]
    if (!y || x.state !== y.state || x.name !== y.name || x.logo !== y.logo) return false
  }
  return true
}

/** Per-panel agent status keyed by panelId, scoped to one workspace. Custom
 *  equality keeps tabs from re-rendering on every 1s poll tick when nothing
 *  actually changed. */
export function useAgentInfoByPanel(workspaceId: string | undefined): Record<string, AgentPanelInfo> {
  const terminal = useStoreWithEqualityFn(
    useStatusStore,
    (s) => selectAgentInfoByPanel(s, workspaceId),
    agentInfoMapEqual,
  )
  const t3 = useT3ActivityStore()
  return { ...terminal, ...selectT3InfoByPanel(t3, workspaceId) }
}

/** Whether a recognized CLI agent is currently open in each terminal panel.
 * Hook-confirmed presence is authoritative; matching the foreground process
 * against the canonical agent registry covers the short interval before the
 * first hook/presence update without teaching the prompt UI its own CLI list. */
export function selectCliAgentOpenByPanel(
  s: StatusStore,
  workspaceId: string | undefined,
): Record<string, boolean> {
  const result: Record<string, boolean> = {}
  const terminals = workspaceId ? s.workspaces[workspaceId]?.terminals : undefined
  if (!terminals) return result
  for (const [key, terminal] of Object.entries(terminals)) {
    result[resolvePanelId(key)] = terminal.agentPresent
  }
  return result
}

function booleanMapEqual(a: Record<string, boolean>, b: Record<string, boolean>): boolean {
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key])
}

export function useCliAgentOpenByPanel(workspaceId: string | undefined): Record<string, boolean> {
  return useStoreWithEqualityFn(
    useStatusStore,
    (state) => selectCliAgentOpenByPanel(state, workspaceId),
    booleanMapEqual,
  )
}

export function selectCliAgentByPanel(
  s: StatusStore,
  workspaceId: string | undefined,
): Record<string, AgentId | null> {
  const result: Record<string, AgentId | null> = {}
  const terminals = workspaceId ? s.workspaces[workspaceId]?.terminals : undefined
  if (!terminals) return result
  for (const [key, terminal] of Object.entries(terminals)) {
    result[resolvePanelId(key)] = terminalAgent(terminal)?.id ?? null
  }
  return result
}

export function useCliAgentByPanel(workspaceId: string | undefined): Record<string, AgentId | null> {
  return useStoreWithEqualityFn(
    useStatusStore,
    (state) => selectCliAgentByPanel(state, workspaceId),
    (a, b) => {
      const keys = Object.keys(a)
      return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key])
    },
  )
}

export function selectT3InfoByPanel(t3: ReturnType<typeof useT3ActivityStore.getState>, workspaceId: string | undefined): Record<string, AgentPanelInfo> {
  const result: Record<string, AgentPanelInfo> = {}
  for (const [id, binding] of Object.entries(t3.panels)) {
    if (binding.workspaceId !== workspaceId) continue
    const thread = t3ThreadForPanel(t3, id)
    const connected = t3PanelConnected(t3, id)
    // Like a terminal, name the agent CLI running the conversation; T3 itself
    // is only the fallback until the thread's provider session is known.
    const provider = thread?.session?.providerName
    const agent = provider ? AGENTS.find((candidate) => candidate.id === agentIdForT3Provider(provider)) : undefined
    const name = agent?.displayName ?? 'T3 Code'
    result[id] = { state: t3PanelActivity(t3, id),
      name: connected ? name : `${name} (disconnected)`, logo: getAgentLogoById(agent?.id) ?? t3Logo }
  }
  return result
}
