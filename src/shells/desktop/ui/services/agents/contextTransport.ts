// How a panel's running agent takes relation context (the relation UI's
// `useContextTransport`): a T3 harness takes it as is; a terminal agent with a
// prompt context hook gets its prompt guidance first. Context is blocked, with
// a warning, for an agent that has no prompt context hook and for one running
// without Cate's hooks.

import type { PanelRecord } from '@workspace/document/contract'
import type { RelationContextTransport } from '../../workspace/relations'
import { clientUi } from '@kernel/interaction'
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
        reason: `${def.displayName} cannot take context from Cate, so connected panels are not sent.`,
      }
    : state.hooksMissing
      ? {
          label: 'Hooks off',
          reason: `${def.displayName} runs without Cate hooks, so connected panels are not sent. Turn its hooks on, then restart it in a new terminal.`,
          fix: { label: 'Agent hooks settings…', run: () => clientUi().openSettings('hooks') },
        }
      : undefined
  return { decorate: (text: string) => (guidance ? `${guidance}\n\n${text}` : text), sentAt, ...(blocked ? { blocked } : {}) }
}
