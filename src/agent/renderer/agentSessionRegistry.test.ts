// Coverage for disposeAgentPanel — the deterministic teardown the appStore
// close paths and the detach handlers call (instead of React unmount). It must
// dispose every pi chat the panel ever spawned AND drop the registry entry so a
// later remount doesn't re-adopt dead chats. This is the mechanism findings 3/4
// depend on to avoid orphaned pi processes after a detach/close.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import {
  saveAgentPanelSession,
  getAgentPanelSession,
  disposeAgentPanel,
  disposeAgentChats,
} from './agentSessionRegistry'
import { useAgentStore } from './agentStore'

// restoreMocks (vitest.config) wipes implementations before each test, so
// (re)install agentDispose's resolved-promise behaviour inside beforeEach.
const agentDispose = vi.fn()

beforeEach(() => {
  agentDispose.mockReset().mockResolvedValue(undefined)
  vi.stubGlobal('window', { electronAPI: { agentDispose } })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('disposeAgentPanel', () => {
  it('disposes every open chat and removes the registry entry', () => {
    const storeDispose = vi.spyOn(useAgentStore.getState(), 'dispose')
    saveAgentPanelSession('panel-1', {
      openChats: [
        { agentKey: 'k1', sessionFile: '/s1.jsonl' },
        { agentKey: 'k2', sessionFile: null },
      ],
      activeAgentKey: 'k1',
      readyByKey: { k1: true, k2: true },
    })

    disposeAgentPanel('panel-1')

    expect(agentDispose).toHaveBeenCalledTimes(2)
    expect(agentDispose).toHaveBeenCalledWith('k1')
    expect(agentDispose).toHaveBeenCalledWith('k2')
    expect(storeDispose).toHaveBeenCalledWith('k1')
    expect(storeDispose).toHaveBeenCalledWith('k2')
    expect(getAgentPanelSession('panel-1')).toBeUndefined()
  })

  it('is a no-op for an unknown panel', () => {
    disposeAgentPanel('does-not-exist')
    expect(agentDispose).not.toHaveBeenCalled()
  })
})

describe('disposeAgentChats', () => {
  // The worktree-switch reinit disposes the old checkout's chats (pi process +
  // store slice) and reopens fresh ones under the SAME panelId, so it must NOT
  // touch the registry entry the way disposeAgentPanel does.
  it('disposes each chat\'s pi + store slice without deleting the registry entry', () => {
    const storeDispose = vi.spyOn(useAgentStore.getState(), 'dispose')
    saveAgentPanelSession('panel-switch', {
      openChats: [{ agentKey: 'old-1', sessionFile: '/wt-x/s.jsonl' }],
      activeAgentKey: 'old-1',
      readyByKey: { 'old-1': true },
    })

    disposeAgentChats([
      { agentKey: 'old-1', sessionFile: '/wt-x/s.jsonl' },
      { agentKey: 'old-2', sessionFile: null },
    ])

    expect(agentDispose).toHaveBeenCalledTimes(2)
    expect(agentDispose).toHaveBeenCalledWith('old-1')
    expect(agentDispose).toHaveBeenCalledWith('old-2')
    expect(storeDispose).toHaveBeenCalledWith('old-1')
    expect(storeDispose).toHaveBeenCalledWith('old-2')
    // Registry entry survives — the panel lives on and reopens in the new cwd.
    expect(getAgentPanelSession('panel-switch')).toBeDefined()
  })

  it('is a no-op for an empty chat list', () => {
    disposeAgentChats([])
    expect(agentDispose).not.toHaveBeenCalled()
  })
})
