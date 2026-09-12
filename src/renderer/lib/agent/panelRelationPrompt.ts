import { compilePanelRelationContext } from '../../../shared/panelRelations'
import type { AgentId } from '../../../shared/agents'
import { useAppStore } from '../../stores/appStore'
import { useSettingsStore } from '../../stores/settingsStore'

const AGENT_PROMPT_GUIDANCE: Partial<Record<AgentId, string>> = {
  codex: [
    '<cate-execution-guidance agent="codex">',
    'Run Cate CLI commands (`cate ...`) outside the Codex sandbox (request escalated execution), because the sandbox cannot reach Cate\'s local `CATE_API` control endpoint.',
    '</cate-execution-guidance>',
  ].join('\n'),
}

export function addAgentPromptGuidance(context: string, agentId: AgentId | null): string {
  const guidance = agentId ? AGENT_PROMPT_GUIDANCE[agentId] : null
  return guidance ? `${context}\n\n${guidance}` : context
}

/** Resolve context at the last possible moment so toggles and graph edits made
 * immediately before submission are honored by terminals and T3 alike. */
export function panelRelationContextForSend(
  workspaceId: string,
  panelId: string,
  agentId: AgentId | null = null,
): string | null {
  if (!useSettingsStore.getState().panelRelationsEnabled) return null
  const workspace = useAppStore.getState().workspaces.find((item) => item.id === workspaceId)
  const panel = workspace?.panels[panelId]
  if (!workspace || !panel || panel.panelRelationContextMode === 'off'
    || panel.panelRelationContextMode === undefined && panel.panelRelationContextEnabled === false) return null
  const context = compilePanelRelationContext(panelId, workspace.panels, workspace.panelRelations ?? [])?.text
  return context ? addAgentPromptGuidance(context, agentId) : null
}

/** Return the currently armed context and immediately disarm it. Submit
 * adapters call this only after a real prompt-submit boundary is reached, so
 * short follow-ups do not repeatedly pay for unchanged canvas context. */
export function consumePanelRelationContextForSend(
  workspaceId: string,
  panelId: string,
  agentId: AgentId | null = null,
): string | null {
  const context = panelRelationContextForSend(workspaceId, panelId, agentId)
  const panel = useAppStore.getState().workspaces
    .find((workspace) => workspace.id === workspaceId)?.panels[panelId]
  if (context && (panel?.panelRelationContextMode ?? 'once') === 'once') {
    useAppStore.getState().setPanelRelationContextMode(workspaceId, panelId, 'off')
  }
  return context
}
