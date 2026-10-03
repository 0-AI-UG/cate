// React selectors over a workspace's agent panel states. The first mounted
// consumer opens the `agents.panels` stream, the last one closes it.

import { useCallback, useRef, useSyncExternalStore } from 'react'
import type { AgentPanelStates, PanelAgentState } from '@services/agents/contract'
import { acquireAgentPanels, peekAgentPanels } from '@services/agents/client'
import { agentInfoByPanel, agentInfoEqual, agentPanelInfo, agentPanelTitle, recordEqual, type AgentPanelInfo } from './panelInfo'

const EMPTY: AgentPanelStates = {}
const noop = () => () => {}

/** Selects from the workspace's agent panel states; re-renders only when the
 *  selected value changes under `isEqual`. */
export function useAgentPanels<T>(
  workspaceId: string | null | undefined,
  selector: (states: AgentPanelStates) => T,
  isEqual: (a: T, b: T) => boolean = Object.is,
): T {
  const subscribe = useCallback((listener: () => void) => {
    if (!workspaceId) return () => {}
    const handle = acquireAgentPanels(workspaceId)
    const off = handle.subscribe(listener)
    return () => {
      off()
      handle.release()
    }
  }, [workspaceId])
  const cache = useRef<{ from: AgentPanelStates; selector: (s: AgentPanelStates) => T; value: T } | null>(null)
  const read = () => {
    const from = workspaceId ? peekAgentPanels(workspaceId) : EMPTY
    const last = cache.current
    if (last && last.from === from && last.selector === selector) return last.value
    const value = selector(from)
    const kept = last && isEqual(last.value, value) ? last.value : value
    cache.current = { from, selector, value: kept }
    return kept
  }
  return useSyncExternalStore(workspaceId ? subscribe : noop, read)
}

const selectInfo = (states: AgentPanelStates) => agentInfoByPanel(states)
const infoMapEqual = (a: Record<string, AgentPanelInfo>, b: Record<string, AgentPanelInfo>) => recordEqual(a, b, agentInfoEqual)

/** Status, name and logo of every agent panel, keyed by panel id. */
export function useAgentInfoByPanel(workspaceId: string | null | undefined): Record<string, AgentPanelInfo> {
  return useAgentPanels(workspaceId, selectInfo, infoMapEqual)
}

/** The agent state of one panel, or undefined when it hosts none. */
export function useAgentPanelState(workspaceId: string | null | undefined, panelId: string): PanelAgentState | undefined {
  const selector = useCallback((states: AgentPanelStates) => states[panelId], [panelId])
  return useAgentPanels(workspaceId, selector)
}

export function useAgentPanelInfo(workspaceId: string | null | undefined, panelId: string): AgentPanelInfo | undefined {
  const state = useAgentPanelState(workspaceId, panelId)
  return state ? agentPanelInfo(state) : undefined
}

/** The title a panel shows: its record title, or the open agent's name in
 *  place of a fallback title. */
export function useAgentPanelTitle(workspaceId: string | null | undefined, panelId: string, title: string): string {
  return agentPanelTitle(title, useAgentPanelState(workspaceId, panelId))
}
