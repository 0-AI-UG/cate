import { AGENTS, type AgentId } from '../../../shared/agents'
import { useAppStore } from '../../stores/appStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { inspectAgentCliHooks, evaluateAgentCliHooks } from '../agent/agentCliHooks'
import { codingAgentTerminalError, handleCodingAgentMethod } from '../agent/codingAgentDriver'
import { requestPanelTarget } from '../panelTargetPicker'
import { parseLocator } from '../../../shared/runtimeLocator'
import { pathKey } from '../../../shared/pathUtils'

export async function inspectReviewAgents(cwd: string, workspaceId: string, fallbackPath?: string) {
  const repoPath = parseLocator(cwd).path
  const [states, fallbackStates] = await Promise.all([
    inspectAgentCliHooks(repoPath),
    fallbackPath && fallbackPath !== repoPath ? inspectAgentCliHooks(fallbackPath) : Promise.resolve([]),
  ])
  const fallbackById = new Map(fallbackStates.map((state) => [state.agent.id, state]))
  const hookConfig = useSettingsStore.getState().agentHookInjection[workspaceId]
  return states.map((state) => ({ agent: state.agent, ready: evaluateAgentCliHooks(state, hookConfig, fallbackById.get(state.agent.id)).ready }))
}

export const unavailableReviewAgents = () => AGENTS.map((agent) => ({ agent, ready: false }))

export async function launchReviewAgent(workspaceId: string, panelId: string, cwd: string, prompt: string, title: string, agentId: AgentId) {
  const workspace = useAppStore.getState().getWorkspace(workspaceId)
  if (!workspace) throw new Error('Workspace not found')
  const existingPanelIds = Object.values(workspace.panels)
    .filter((panel) => panel.type === 'terminal' && codingAgentTerminalError(workspaceId, panel.id, panelId) === null)
    .map((panel) => panel.id)
  const target = await requestPanelTarget({ workspaceId, panelType: 'terminal', availability: 'both', existingPanelIds, sourcePanelId: panelId })
  if (!target) return null
  const repoPath = parseLocator(cwd).path
  const worktree = workspace.worktrees?.find((candidate) => pathKey(parseLocator(candidate.path).path) === pathKey(repoPath))
  const outcome = await handleCodingAgentMethod(workspaceId, panelId, 'cate.codingAgent.create', {
    agentId, prompt, title, background: false, _cateOriginCwd: repoPath,
    ...(worktree ? { worktreeId: worktree.id } : {}), ...(target.kind === 'existing' ? { terminalPanelId: target.panelId } : {}),
  }, target.kind === 'new' ? { placement: target.placement } : undefined)
  if (!outcome.ok) throw new Error(outcome.error)
  const result = outcome.result as { id?: unknown; panelId?: unknown } | null
  if (typeof result?.id !== 'string' || typeof result.panelId !== 'string') throw new Error('Agent launch did not return a run')
  const launched = { runId: result.id, terminalPanelId: result.panelId }
  const app = useAppStore.getState()
  const state = app.getWorkspace(workspaceId)?.panels[panelId]?.reviewState
  if (state) app.setPanelReviewState(workspaceId, panelId, { ...state, agentReview: { ...launched, status: 'working', startedAt: Date.now() } })
  return launched
}
