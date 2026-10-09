// How a panel's running agent takes relation context (the relation UI's
// `useContextTransport`), from the policy its runner computed: as is, after
// prompt guidance, or blocked with a warning for an agent that has no prompt
// context hook. An agent running without Cate's hooks gets the panel's own
// Hooks off chip instead.

import type { PanelRecord } from '@workspace/document/contract'
import type { RelationContextTransport } from '../../workspace/relations'
import { AGENT_DEFS } from '@services/agents/contract'
import { useAgentPanelState } from './useAgentPanels'

export function useAgentContextTransport(workspaceId: string, panel: PanelRecord): RelationContextTransport | null {
  const state = useAgentPanelState(workspaceId, panel.id)
  const policy = state?.contextPolicy
  if (!state || !policy) return null
  const sentAt = state.contextSentAt
  switch (policy.kind) {
    case 'plain':
      return { decorate: (text: string) => text, sentAt }
    case 'guided': {
      const { guidance } = policy
      return { decorate: (text: string) => (guidance ? `${guidance}\n\n${text}` : text), sentAt }
    }
    case 'unsupported': {
      const name = state.agentId ? AGENT_DEFS[state.agentId].displayName : 'This agent'
      return { decorate: (text: string) => text, sentAt, blocked: { label: 'Not supported', reason: `${name} can't receive context` } }
    }
  }
}
