// @vitest-environment jsdom
//
// A coding chat's durable title must track pi's assigned session name so the
// sidebar tab strip (reads the durable Chat.title) matches the panel's own chat
// list (reads pi's live title). writeBackSessionTitle is the single write-back
// point refreshStatsAndState calls; these pin its behaviour.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { writeBackSessionTitle } from './useCodingChat'
import { useChatsStore } from '../../renderer/stores/chatsStore'

const ROOT = '/repo'
const AGENT_KEY = 'coding:abc'

const projectChatsSave = vi.fn().mockResolvedValue(undefined)

beforeEach(() => {
  projectChatsSave.mockClear()
  ;(window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = { projectChatsSave }
  useChatsStore.setState({ chatsByRoot: {}, loadedRoots: {} })
})

afterEach(() => {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI
})

function seedChat(title: string) {
  return useChatsStore.getState().createCodingChat(ROOT, {
    agentKey: AGENT_KEY,
    sessionFile: null,
    title,
  })
}

describe('writeBackSessionTitle', () => {
  it('updates the durable coding chat title to pi\'s assigned session name', () => {
    const chat = seedChat('New chat')

    writeBackSessionTitle(ROOT, AGENT_KEY, 'Fix the parser')

    expect(useChatsStore.getState().getChat(ROOT, chat.id)?.title).toBe('Fix the parser')
    // The persist ran once at creation and once for the title write-back.
    expect(projectChatsSave).toHaveBeenCalledTimes(2)
  })

  it('does not write when the name is unchanged (no redundant persist)', () => {
    seedChat('Fix the parser')
    projectChatsSave.mockClear()

    writeBackSessionTitle(ROOT, AGENT_KEY, 'Fix the parser')

    expect(projectChatsSave).not.toHaveBeenCalled()
  })

  it('does not write when pi has no session name yet', () => {
    const chat = seedChat('New chat')
    projectChatsSave.mockClear()

    writeBackSessionTitle(ROOT, AGENT_KEY, '')
    writeBackSessionTitle(ROOT, AGENT_KEY, null)
    writeBackSessionTitle(ROOT, AGENT_KEY, undefined)

    expect(projectChatsSave).not.toHaveBeenCalled()
    expect(useChatsStore.getState().getChat(ROOT, chat.id)?.title).toBe('New chat')
  })

  it('ignores agentKeys with no matching durable chat', () => {
    seedChat('New chat')
    projectChatsSave.mockClear()

    writeBackSessionTitle(ROOT, 'coding:other', 'Fix the parser')

    expect(projectChatsSave).not.toHaveBeenCalled()
  })
})
