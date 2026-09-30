import type { AgentSessionRef } from '../../../shared/agentConversation'
import { AGENTS, agentIdForT3Provider } from '../../../shared/agents'
import { formatLocator, parseLocator } from '../../../shared/runtimeLocator'
import type { PanelState, WorkspaceState } from '../../../shared/types'

/** The checkout an agent (T3) panel's conversations belong to, as a locator. */
export function agentPanelCwd(workspace: WorkspaceState, panel: PanelState): string {
  return panel.cwd
    ?? workspace.worktrees?.find((worktree) => worktree.id === panel.worktreeId)?.path
    ?? workspace.rootPath
}

/** The agent session a panel hosts, in the one shape every agent surface
 *  shares (hooks-branch version: branches on panel.type until the panel
 *  framework lands). */
export function agentSessionForPanel(
  workspace: WorkspaceState,
  panel: PanelState,
  t3ProviderName?: string | null,
): AgentSessionRef | undefined {
  if (panel.type === 'terminal' && panel.agentSession) {
    const { agentId, sessionId, cwd, profile } = panel.agentSession
    const agent = AGENTS.find((candidate) => candidate.id === agentId)
    if (!agent) return undefined
    const runtimeId = parseLocator(workspace.rootPath).runtimeId
    return {
      host: 'terminal', agentId: agent.id, sessionId,
      cwd: cwd ? formatLocator({ runtimeId, path: cwd }) : workspace.rootPath,
      ...(profile ? { profile } : {}),
    }
  }
  if (panel.type === 'agent' && panel.agentThreadId) {
    return { host: 't3', agentId: t3ProviderName ? agentIdForT3Provider(t3ProviderName) : null, sessionId: panel.agentThreadId, cwd: agentPanelCwd(workspace, panel) }
  }
  return undefined
}
