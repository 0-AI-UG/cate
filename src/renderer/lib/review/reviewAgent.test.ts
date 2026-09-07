import { beforeEach, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ inspect: vi.fn(async () => []), setState: vi.fn(), state: { repoPath: '/repo', agentReview: { runId: 'review', status: 'complete' } } }))
vi.mock('../../stores/appStore', () => ({ useAppStore: { getState: () => ({ getWorkspace: () => ({ panels: { review: { reviewState: h.state } }, worktrees: [] }), setPanelReviewState: h.setState }) } }))
vi.mock('../../stores/settingsStore', () => ({ useSettingsStore: { getState: () => ({ agentHookInjection: {} }) } }))
vi.mock('../agent/agentCliHooks', () => ({ inspectAgentCliHooks: h.inspect, evaluateAgentCliHooks: () => ({ ready: true }) }))
vi.mock('../agent/codingAgentDriver', () => ({ codingAgentTerminalError: () => null, handleCodingAgentMethod: async () => ({ ok: true, result: { id: 'edit', panelId: 'terminal' } }) }))
vi.mock('../panelTargetPicker', () => ({ requestPanelTarget: async () => ({ kind: 'new', placement: { target: 'canvas' } }) }))
import { inspectReviewAgents, launchReviewAgent } from './reviewAgent'

beforeEach(() => vi.clearAllMocks())
it('preserves the completed review when launching an agent to address findings', async () => {
  await launchReviewAgent('ws', 'review', '/repo', 'Address findings', 'Address review findings', 'codex')
  expect(h.setState).not.toHaveBeenCalled()
})
it('inspects the remote checkout using its runtime locator', async () => {
  await inspectReviewAgents('cate-runtime://host/repo', 'ws')
  expect(h.inspect).toHaveBeenCalledWith('cate-runtime://host/repo')
})
