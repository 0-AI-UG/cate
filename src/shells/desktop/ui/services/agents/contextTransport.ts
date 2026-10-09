// How a panel's running agent takes relation context (the relation UI's
// `useContextTransport`), from the policy its runner computed: it takes it,
// or it is blocked with a warning (no prompt context hook). An agent running
// without Cate's hooks gets the panel's own Hooks off chip instead. What
// would go is the runtime's preview (`agentContextPreview`).

import type { PanelRecord } from '@workspace/document/contract'
import { tryRuntimeFor } from '@kernel/rpc/client'
import type { RelationContextTransport } from '../../workspace/relations'
import { AGENT_DEFS } from '@services/agents/contract'
import { useAgentPanelState } from './useAgentPanels'

export function useAgentContextTransport(workspaceId: string, panel: PanelRecord): RelationContextTransport | null {
  const state = useAgentPanelState(workspaceId, panel.id)
  if (!state?.contextPolicy) return null
  const sentAt = state.contextSentAt
  if (state.contextPolicy === 'supported') return { sentAt }
  const name = state.agentId ? AGENT_DEFS[state.agentId].displayName : 'This agent'
  return { sentAt, blocked: { label: 'Not supported', reason: `${name} can't receive context` } }
}

/** The relation context the panel's next prompt would take, as the runtime
 *  would send it. */
export async function agentContextPreview(workspaceId: string, panelId: string): Promise<string | null> {
  return (await tryRuntimeFor(workspaceId)?.agents.previewContext({ panelId })) ?? null
}
