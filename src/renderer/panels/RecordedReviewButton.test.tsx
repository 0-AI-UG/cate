import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const h = vi.hoisted(() => ({ target: vi.fn(), launch: vi.fn(), setState: vi.fn() }))
vi.mock('../stores/appStore', () => ({ useAppStore: { getState: () => ({ setPanelReviewState: h.setState, getWorkspace: () => ({ rootPath: '/repo', panels: { review: { reviewState: { repoPath: '/repo', agentChanges: { panelId: 'source' } } } }, worktrees: [] }) }) } }))
vi.mock('../stores/settingsStore', () => ({ useSettingsStore: { getState: () => ({ agentHookInjection: {} }) } }))
vi.mock('../lib/agent/agentCliHooks', () => ({ inspectAgentCliHooks: async () => [{ agent: { id: 'codex', displayName: 'Codex' } }], evaluateAgentCliHooks: () => ({ ready: true }) }))
vi.mock('../lib/agent/codingAgentDriver', () => ({ codingAgentTerminalError: () => null, handleCodingAgentMethod: h.launch }))
vi.mock('../lib/panelTargetPicker', () => ({ requestPanelTarget: h.target }))
import { RecordedReviewButton } from './RecordedReviewButton'
import type { AgentChangeRecord } from '../../shared/agentChanges'
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
let host: HTMLDivElement
let root: ReturnType<typeof createRoot>
const records = [{ agentId: 'codex', files: [{ path: 'captured.ts', coverage: 'patch', patch: '-before\n+after' }] }] as AgentChangeRecord[]
beforeEach(() => {
  vi.clearAllMocks()
  h.target.mockResolvedValue({ kind: 'new', placement: { kind: 'canvas', canvasPanelId: 'canvas', point: { x: 0, y: 0 } } })
  h.launch.mockResolvedValue({ ok: true, result: { id: 'run', panelId: 'terminal' } })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove() })
async function open() {
  await act(async () => root.render(<RecordedReviewButton records={records} cwd="/repo" workspaceId="ws" panelId="review" />))
  await act(async () => host.querySelector('button')!.click())
}
async function confirm() {
  await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((button) => button.textContent === 'Start review')!.click())
}
it('places a terminal and sends captured evidence with the correct checkout', async () => {
  await open()
  expect(document.querySelector('[role="radiogroup"][aria-label="Terminal CLI"]')).not.toBeNull()
  expect(document.querySelector('[role="radio"][aria-checked="true"]')?.textContent).toBe('Codex')
  expect(document.querySelector('select')).toBeNull()
  await confirm()
  expect(h.target).toHaveBeenCalledWith(expect.objectContaining({ panelType: 'terminal', sourcePanelId: 'review', workspaceId: 'ws', availability: 'both' }))
  expect(h.launch).toHaveBeenCalledWith('ws', 'review', 'cate.codingAgent.create', expect.objectContaining({ agentId: 'codex', _cateOriginCwd: '/repo', prompt: expect.stringContaining('captured.ts (patch)\n-before\n+after') }), expect.objectContaining({ placement: expect.any(Object) }))
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(h.launch.mock.calls[0][3].prompt).toContain('cate review complete')
  expect(h.setState).toHaveBeenCalledWith('ws', 'review', expect.objectContaining({ agentChanges: { panelId: 'source' }, agentReview: { runId: 'run', terminalPanelId: 'terminal', status: 'working', startedAt: expect.any(Number) } }))
})
it('does not launch when placement is cancelled', async () => {
  h.target.mockResolvedValue(null)
  await open(); await confirm()
  expect(h.launch).not.toHaveBeenCalled()
  expect(h.setState).not.toHaveBeenCalled()
})
it('reuses an existing terminal and displays launch failures', async () => {
  h.target.mockResolvedValue({ kind: 'existing', panelId: 'existing-terminal' })
  h.launch.mockResolvedValue({ ok: false, error: 'CLI unavailable' })
  await open(); await confirm()
  expect(h.launch).toHaveBeenCalledWith('ws', 'review', 'cate.codingAgent.create', expect.objectContaining({ terminalPanelId: 'existing-terminal' }), undefined)
  expect(document.querySelector('[role="alert"]')?.textContent).toBe('CLI unavailable')
})
