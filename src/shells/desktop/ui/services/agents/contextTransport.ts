// How a panel's running agent takes relation context (the relation UI's
// `useContextTransport`): a T3 harness takes it as is; a terminal agent with a
// prompt context hook gets its prompt guidance first. Context is blocked, with
// a warning, for an agent that has no prompt context hook. An agent running
// without Cate's hooks gets the panel's own Hooks off chip instead.

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
  if (!def) return null
  const guidance = def.promptGuidance
  const blocked: RelationContextTransport['blocked'] = !def.promptContextHook
    ? {
        label: 'Not supported',
        reason: `${def.displayName} can't receive context`,
      }
    : undefined
  return { decorate: (text: string) => (guidance ? `${guidance}\n\n${text}` : text), sentAt, ...(blocked ? { blocked } : {}) }
}
