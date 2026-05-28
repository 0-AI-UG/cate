// Per-panel agent status (state + name + logo) for the sidebar tree and dock
// tabs. Owns the two bits of glue both consumers used to re-derive by hand:
//   1. the ptyId→panelId translation (status is keyed by ptyId, tabs by panelId)
//   2. the `agentPresent` gate on the name/logo
// so the invariant lives in one place instead of being copied per consumer.

import { useStoreWithEqualityFn } from 'zustand/traditional'
import { useStatusStore, type StatusStore } from '../stores/statusStore'
import { terminalRegistry } from '../lib/terminalRegistry'
import { getAgentLogo } from '../lib/agentLogos'
import type { AgentState } from '../../shared/types'

export interface AgentPanelInfo {
  state: AgentState
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

function selectAgentInfoByPanel(
  s: StatusStore,
  workspaceId: string | undefined,
): Record<string, AgentPanelInfo> {
  const out: Record<string, AgentPanelInfo> = {}
  const ws = workspaceId ? s.workspaces[workspaceId] : undefined
  if (!ws) return out
  for (const [key, state] of Object.entries(ws.agentState)) {
    // `agentName` is kept populated after the agent exits so the status
    // footer can still read "Finished (Claude Code)". Gate the name/logo on
    // `agentPresent` so the icon reverts to the terminal glyph the moment
    // the process is gone; leave `state` ungated so the finished/awaiting
    // indicators still render.
    const name = ws.agentPresent[key] ? (ws.agentName[key] ?? null) : null
    out[resolvePanelId(key)] = { state, name, logo: getAgentLogo(name) }
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
  return useStoreWithEqualityFn(
    useStatusStore,
    (s) => selectAgentInfoByPanel(s, workspaceId),
    agentInfoMapEqual,
  )
}
