import { afterEach, beforeEach, expect, it, vi } from 'vitest'
vi.mock('./terminal/terminalRegistry', () => ({ terminalRegistry: { release: vi.fn() } }))
vi.mock('./logger', () => ({ default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('./closePanelWithConfirm', () => ({ closePanelWithConfirm: vi.fn().mockResolvedValue(true) }))
import { runAction } from './runAction'
import { closePanelWithConfirm } from './closePanelWithConfirm'
import { useAppStore } from '../stores/appStore'
import { setActivePanel } from './activePanel'
import { getOrCreateCanvasStoreForPanel, releaseCanvasStoreForPanel } from '../stores/canvasStore'
const original = useAppStore.getState()
beforeEach(() => {
  useAppStore.setState({ selectedWorkspaceId: 'ws', workspaces: [{ id: 'ws', rootPath: '/repo', panels: {
    canvas: { id: 'canvas', type: 'canvas', title: 'Canvas' },
    old: { id: 'old', type: 'editor', title: 'Old' },
    focused: { id: 'focused', type: 'terminal', title: 'Terminal', cwd: '/feature/sub', worktreeId: 'feature' },
  }, worktrees: [{ id: 'feature', path: '/feature', branch: 'feature' }] }] } as never)
  const canvas = getOrCreateCanvasStoreForPanel('canvas')
  const node = canvas.getState().addNode('old', 'editor')
  canvas.getState().focusNode(node)
  setActivePanel('focused')
})
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); releaseCanvasStoreForPanel('canvas'); useAppStore.setState(original, true); setActivePanel(null) })
it('closes the focused dock leaf instead of the previous canvas selection', async () => {
  await runAction('closePanel')
  expect(closePanelWithConfirm).toHaveBeenCalledWith('ws', 'focused')
})
it.each(['newTerminal', 'newAgent', 'newEditor'] as const)('%s inherits the focused dock checkout', async (action) => {
  const terminal = vi.spyOn(useAppStore.getState(), 'createTerminal').mockReturnValue('created')
  const agent = vi.spyOn(useAppStore.getState(), 'createAgent').mockReturnValue('created')
  const editor = vi.spyOn(useAppStore.getState(), 'createEditor').mockReturnValue('created')
  const bind = vi.spyOn(useAppStore.getState(), 'setPanelWorktreeId').mockImplementation(() => {})
  await runAction(action)
  if (action === 'newTerminal') expect(terminal.mock.calls[0][4]).toBe('/feature/sub')
  if (action === 'newAgent') expect(agent.mock.calls[0].slice(3)).toEqual(['/feature/sub', 'feature'])
  if (action === 'newEditor') { expect(editor).toHaveBeenCalled(); expect(bind).toHaveBeenCalledWith('ws', 'created', 'feature') }
})
