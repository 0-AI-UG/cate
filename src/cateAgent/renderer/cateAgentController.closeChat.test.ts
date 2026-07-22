// @vitest-environment jsdom
//
// Deleting a Cate Agent chat with unmerged work must PROMPT (never silently discard).
// closeChat is the single delete path for every chat list. These pin the gate: a
// chat with a run that has a worktree /
// review / iterations calls confirmDiscardJob and aborts on Cancel; a chat with no
// such work is removed straight through.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ChatRun } from '../../shared/types'

// The proceed path disposes the orchestrator pi session; stub it so the test stays
// hermetic (no agent runtime / IPC).
vi.mock('./cateAgentSession', () => ({
  observerPanelId: (id: string) => `obs-${id}`,
  orchestratorPanelId: (id: string) => `orch-${id}`,
  createCateAgentSession: vi.fn(),
  promptCateAgent: vi.fn(),
  interruptCateAgent: vi.fn(),
  disposeCateAgent: vi.fn().mockResolvedValue(undefined),
}))

// The proceed path tears down the run's worktree/terminals; stub it so no git/fs
// IPC runs (the gate, not teardown, is under test here).
vi.mock('./cateAgentReviewActions', () => ({
  teardownRunWork: vi.fn().mockResolvedValue(undefined),
}))

import { cateAgentController } from './cateAgentController'
import { useChatsStore } from '../../renderer/stores/chatsStore'

const WS = 'ws-1'
const ROOT = '/repo'
const CHAT = 'chat-1'

const removeChat = vi.fn()
let run: ChatRun | undefined

beforeEach(() => {
  run = undefined
  removeChat.mockReset()
  vi.spyOn(useChatsStore, 'getState').mockReturnValue({
    getRun: (_root: string, _id: string) => run,
    removeChat,
  } as unknown as ReturnType<typeof useChatsStore.getState>)
})

afterEach(() => {
  vi.restoreAllMocks()
  delete (window as unknown as { electronAPI?: unknown }).electronAPI
})

function stubConfirm(choice: 'discard' | 'cancel') {
  const confirmDiscardJob = vi.fn().mockResolvedValue(choice)
  ;(window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = { confirmDiscardJob }
  return confirmDiscardJob
}

describe('cateAgentController.closeChat review gate', () => {
  it('prompts on unmerged work and, on Cancel, does not delete', async () => {
    run = { status: 'review', worktreeId: 'wt-9', terminalNodeIds: ['t1', 't2'] }
    const confirm = stubConfirm('cancel')

    const deleted = await cateAgentController.closeChat(WS, ROOT, CHAT)

    expect(deleted).toBe(false)
    expect(confirm).toHaveBeenCalledWith({ hasWorktree: true, terminalCount: 2 })
    expect(removeChat).not.toHaveBeenCalled()
  })

  it('prompts on unmerged work and, on Discard, deletes', async () => {
    run = { status: 'review', worktreeId: 'wt-9' }
    const confirm = stubConfirm('discard')

    const deleted = await cateAgentController.closeChat(WS, ROOT, CHAT)

    expect(deleted).toBe(true)
    expect(confirm).toHaveBeenCalled()
    expect(removeChat).toHaveBeenCalledWith(ROOT, CHAT)
  })

  it('deletes without prompting when there is no unmerged work', async () => {
    run = undefined
    const confirm = stubConfirm('cancel')

    const deleted = await cateAgentController.closeChat(WS, ROOT, CHAT)

    expect(deleted).toBe(true)
    expect(confirm).not.toHaveBeenCalled()
    expect(removeChat).toHaveBeenCalledWith(ROOT, CHAT)
  })
})
