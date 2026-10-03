// How a panel's running agent takes relation context (the relation UI's
// `useContextTransport`): a T3 harness takes it as is; a terminal agent with a
// prompt context hook gets its prompt guidance first; others take none.

import type { PanelRecord } from '@workspace/document/contract'
import type { RelationContextTransport } from '../../workspace/relations'
import { AGENT_DEFS } from '@services/agents/contract'
import { useAgentPanelState } from './useAgentPanels'

export function useAgentContextTransport(workspaceId: string, panel: PanelRecord): RelationContextTransport | null {
  const state = useAgentPanelState(workspaceId, panel.id)
  if (!state) return null
  const sentAt = state.contextSentAt
  if (state.runner === 't3') return { decorate: (text: string) => text, sentAt }
  const def = state.agentId ? AGENT_DEFS[state.agentId] : undefined
  if (!def?.promptContextHook) return null
  const guidance = def.promptGuidance
  return { decorate: (text: string) => (guidance ? `${guidance}\n\n${text}` : text), sentAt }
}
