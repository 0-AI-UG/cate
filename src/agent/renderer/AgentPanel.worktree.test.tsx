// Coverage for switchAgentWorktree — the confirm gate in front of the agent
// panel's worktree picker. Switching the panel's worktree changes its cwd,
// which disposes every open chat and reopens a single fresh one, so a pick made
// while there is real work in the panel must ask first and must not write
// through to setPanelWorktreeId unless the user accepts.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import { switchAgentWorktree } from './AgentPanel'
import { useAppStore } from '../../renderer/stores/appStore'

const confirmSwitchAgentWorktree = vi.fn()
const target = { id: 'wt-2', path: '/repo/.cate/worktrees/feat', branch: 'feat' }

const base = {
  workspaceId: 'ws-1',
  panelId: 'panel-1',
  target,
  cwd: '/repo',
}

let setPanelWorktreeId: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  confirmSwitchAgentWorktree.mockReset().mockResolvedValue('cancel')
  ;(window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
    confirmSwitchAgentWorktree,
  }
  setPanelWorktreeId = vi.spyOn(useAppStore.getState(), 'setPanelWorktreeId').mockImplementation(() => {})
})

afterEach(() => {
  setPanelWorktreeId.mockRestore()
})

describe('switchAgentWorktree', () => {
  it('asks before a switch that would drop a chat with messages, and does not write on cancel', async () => {
    const ok = await switchAgentWorktree({ ...base, chatCount: 1, hasMessages: true })

    expect(ok).toBe(false)
    expect(confirmSwitchAgentWorktree).toHaveBeenCalledTimes(1)
    expect(confirmSwitchAgentWorktree).toHaveBeenCalledWith({
      chatCount: 1,
      hasMessages: true,
      worktreeName: 'feat',
    })
    expect(setPanelWorktreeId).not.toHaveBeenCalled()
  })

  it('writes through once the user accepts', async () => {
    confirmSwitchAgentWorktree.mockResolvedValue('switch')

    const ok = await switchAgentWorktree({ ...base, chatCount: 1, hasMessages: true })

    expect(ok).toBe(true)
    expect(setPanelWorktreeId).toHaveBeenCalledWith('ws-1', 'panel-1', 'wt-2')
  })

  it('asks when more than one chat is open even with no messages', async () => {
    await switchAgentWorktree({ ...base, chatCount: 2, hasMessages: false })

    expect(confirmSwitchAgentWorktree).toHaveBeenCalledTimes(1)
    expect(setPanelWorktreeId).not.toHaveBeenCalled()
  })

  it('switches silently with a single empty chat', async () => {
    const ok = await switchAgentWorktree({ ...base, chatCount: 1, hasMessages: false })

    expect(ok).toBe(true)
    expect(confirmSwitchAgentWorktree).not.toHaveBeenCalled()
    expect(setPanelWorktreeId).toHaveBeenCalledWith('ws-1', 'panel-1', 'wt-2')
  })

  it('never asks when the target resolves to the current checkout', async () => {
    const ok = await switchAgentWorktree({
      ...base,
      target: { ...target, path: '/repo' },
      chatCount: 3,
      hasMessages: true,
    })

    expect(ok).toBe(true)
    expect(confirmSwitchAgentWorktree).not.toHaveBeenCalled()
    expect(setPanelWorktreeId).toHaveBeenCalledWith('ws-1', 'panel-1', 'wt-2')
  })
})
