// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
const h = vi.hoisted(() => ({ closed: [] as string[], close: vi.fn() }))
vi.mock('../stores/appStore', () => ({ useAppStore: { getState: () => ({ closePanel: h.close }) } }))
vi.mock('./confirmClosePanels', () => ({ confirmClosePanels: async () => true }))
import { prepareWorktreePanelsForClose, closePreparedWorktreePanels } from './worktreePanelClose'
it('does not close an earlier detached panel when a later owner cancels', async () => {
  h.closed = []
  Object.assign(window.electronAPI, { closeWindowPanel: vi.fn(async (id: string, options?: { phase: string }) => {
    if (id === 'second' && options?.phase !== 'cancel') return false
    if (!options || options.phase === 'commit') h.closed.push(id)
    return true
  }) })
  expect(await prepareWorktreePanelsForClose('ws', { localPanelIds: [], otherWindowPanelIds: ['first', 'second'], hasDirtyEditor: true })).toBe(false)
  expect(h.closed).toEqual([])
})
it('commits detached and local removals only after preparation succeeds', async () => {
  h.closed = []
  Object.assign(window.electronAPI, { closeWindowPanel: vi.fn(async (id: string, options?: { phase: string }) => {
    if (!options || options.phase === 'commit') h.closed.push(id)
    return true
  }) })
  const targets = { localPanelIds: ['local'], otherWindowPanelIds: ['remote'], hasDirtyEditor: false }
  expect(await prepareWorktreePanelsForClose('ws', targets)).toBe(true)
  expect(h.closed).toEqual([])
  await closePreparedWorktreePanels('ws', targets)
  expect(h.closed).toEqual(['remote'])
  expect(h.close).toHaveBeenCalledWith('ws', 'local')
})
it('cancels earlier preparations when another owner request rejects', async () => {
  const routed = vi.fn(async (id: string, operation?: { phase: string }) => {
    if (id === 'broken' && operation?.phase === 'prepare') throw new Error('owner transport failed')
    return true
  })
  Object.assign(window.electronAPI, { closeWindowPanel: routed })
  const targets = { localPanelIds: [], otherWindowPanelIds: ['prepared', 'broken'], hasDirtyEditor: false }
  await expect(prepareWorktreePanelsForClose('ws', targets)).resolves.toBe(false)
  expect(routed).toHaveBeenCalledWith('prepared', expect.objectContaining({ phase: 'cancel' }))
  expect(targets).not.toHaveProperty('closeToken')
})
