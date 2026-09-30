// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest'
import type { PanelState, WorkspaceState } from '../../../shared/types'
import { useAppStore } from '../../stores/appStore'
import { useT3ActivityStore } from '../../stores/t3ActivityStore'
import { registerAgentPanelSender, sendPromptToAgentPanel } from './agentPanelControl'

vi.mock('./panelRelationPrompt', () => ({ preparePanelRelationContextForSend: async () => 'Connected panels: browser' }))

const startTurn = vi.fn(async (_request: unknown) => ({ ok: true }))
let sequence = 0

function agentPanel(patch: Partial<PanelState> = {}): void {
  const record = { id: 't3', type: 'agent', title: 'Agent', isDirty: false, ...patch } as PanelState
  useAppStore.setState({ workspaces: [{ id: 'ws', rootPath: '/repo', panels: { t3: record } } as unknown as WorkspaceState] })
  useT3ActivityStore.getState().bind('t3', { workspaceId: 'ws', partition: 'p', threadId: patch.agentThreadId })
}
const report = (threads: Record<string, unknown> = {}, connected = true) =>
  useT3ActivityStore.getState().apply({ partition: 'p', connected, sequence: ++sequence, threads: threads as never })

beforeEach(() => {
  startTurn.mockClear()
  window.electronAPI = { agentHarnessStartTurn: startTurn } as unknown as typeof window.electronAPI
  useT3ActivityStore.setState({ instances: {}, panels: {} })
})

it('sends to a bound T3 thread through main once the harness is connected', async () => {
  agentPanel({ agentThreadId: 'th' })
  await expect(sendPromptToAgentPanel('ws', 't3', 'hi')).resolves.toEqual({ ok: false, error: 'agent-not-running' })
  report({ th: { id: 'th', title: 'Chat' } })
  await expect(sendPromptToAgentPanel('ws', 't3', 'hi')).resolves.toEqual({ ok: true })
  expect(startTurn).toHaveBeenCalledWith({ workspaceId: 'ws', cwd: '/repo', threadId: 'th', text: 'hi\n\nConnected panels: browser' })
  report({ th: { id: 'th', title: 'Chat', latestTurn: { state: 'running' } } })
  await expect(sendPromptToAgentPanel('ws', 't3', 'again')).resolves.toEqual({ ok: false, error: 'agent-busy' })
})

it('lets a connected fresh chat take its first prompt through the page composer', async () => {
  agentPanel()
  await expect(sendPromptToAgentPanel('ws', 't3', 'hi')).resolves.toEqual({ ok: false, error: 'agent-not-running' })
  report()
  await expect(sendPromptToAgentPanel('ws', 't3', 'hi')).resolves.toEqual({ ok: false, error: 'agent-panel-unavailable' })
  const composer = vi.fn(async () => true)
  const release = registerAgentPanelSender('t3', composer)
  await expect(sendPromptToAgentPanel('ws', 't3', 'hi')).resolves.toEqual({ ok: true })
  expect(composer).toHaveBeenCalledWith('hi')
  expect(startTurn).not.toHaveBeenCalled()
  release()
  report({}, false)
  await expect(sendPromptToAgentPanel('ws', 't3', 'hi')).resolves.toEqual({ ok: false, error: 'agent-not-running' })
})
