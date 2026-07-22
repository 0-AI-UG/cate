// Coverage for the inverted coding-chat ownership.
//
// SEMANTICS CHANGE (was: close disposes the pi session): the workspace (chatsStore)
// now OWNS coding chats durably, so they OUTLIVE the panel hosting them. Therefore:
//   - disposeAgentPanel (the appStore close / detach path) removes the panel's
//     REFERENCES only — it must NOT dispose the pi session or the store slice, and
//     it must NOT touch chats.json. A later mount re-adopts the still-live chat.
//   - disposeCodingChat is the ONLY disposer: an explicit chat delete disposes the
//     pi process + store slice AND drops the durable chats.json record.
//   - disposeAgentChats stays the worktree-switch reinit helper: dispose pi + slice
//     for the abandoned old-checkout chats, without touching the registry entry.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import {
  saveAgentPanelSession,
  getAgentPanelSession,
  disposeAgentPanel,
  disposeAgentChats,
  disposeCodingChat,
  resolvePanelChats,
  beginAgentCreate,
  endAgentCreate,
} from './agentSessionRegistry'
import { useAgentStore } from './agentStore'
import { useChatsStore } from '../../renderer/stores/chatsStore'

// restoreMocks (vitest.config) wipes implementations before each test, so
// (re)install the electronAPI stubs' resolved-promise behaviour in beforeEach.
const agentDispose = vi.fn()
const projectChatsSave = vi.fn()

beforeEach(() => {
  agentDispose.mockReset().mockResolvedValue(undefined)
  projectChatsSave.mockReset().mockResolvedValue(undefined)
  vi.stubGlobal('window', { electronAPI: { agentDispose, projectChatsSave } })
  // Module-level singletons: reset their state so tests don't leak into each other.
  useChatsStore.setState({ chatsByRoot: {}, loadedRoots: {} })
  useAgentStore.setState({ panels: {} })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('disposeAgentPanel (panel close = reference removal)', () => {
  it('removes the panel references but does NOT dispose the pi session or store slice', () => {
    const storeDispose = vi.spyOn(useAgentStore.getState(), 'dispose')
    saveAgentPanelSession('panel-1', {
      openChats: [
        { agentKey: 'k1', sessionFile: '/s1.jsonl', chatId: 'c1' },
        { agentKey: 'k2', sessionFile: null, chatId: 'c2' },
      ],
      activeAgentKey: 'k1',
      readyByKey: { k1: true, k2: true },
    })

    disposeAgentPanel('panel-1')

    // References gone…
    expect(getAgentPanelSession('panel-1')).toBeUndefined()
    // …but the chat's pi + slice are UNTOUCHED (the durable chat can be re-adopted).
    expect(agentDispose).not.toHaveBeenCalled()
    expect(storeDispose).not.toHaveBeenCalled()
  })

  it('is a no-op for an unknown panel', () => {
    disposeAgentPanel('does-not-exist')
    expect(agentDispose).not.toHaveBeenCalled()
  })
})

describe('disposeCodingChat (explicit delete = the only disposer)', () => {
  it('disposes the pi session + store slice AND removes the chats.json record', () => {
    const rootPath = '/repo'
    const storeDispose = vi.spyOn(useAgentStore.getState(), 'dispose')
    useAgentStore.getState().init('k9')
    const chat = useChatsStore.getState().createCodingChat(rootPath, {
      agentKey: 'k9',
      sessionFile: '/s9.jsonl',
      title: 'A coding chat',
    })
    expect(useChatsStore.getState().getChat(rootPath, chat.id)).toBeDefined()

    disposeCodingChat(rootPath, chat.id)

    expect(agentDispose).toHaveBeenCalledWith('k9')
    expect(storeDispose).toHaveBeenCalledWith('k9')
    // The durable record is gone (and the removal persisted to chats.json).
    expect(useChatsStore.getState().getChat(rootPath, chat.id)).toBeUndefined()
    expect(projectChatsSave).toHaveBeenCalled()
  })

  it('still drops a record whose pi is already gone (no agentKey match)', () => {
    const rootPath = '/repo'
    const chat = useChatsStore.getState().createCodingChat(rootPath, {
      agentKey: 'gone', sessionFile: null, title: 'orphan',
    })
    // No slice for "gone" — dispose is best-effort; the record must still vanish.
    disposeCodingChat(rootPath, chat.id)
    expect(useChatsStore.getState().getChat(rootPath, chat.id)).toBeUndefined()
  })
})

describe('disposeAgentChats (worktree-switch reinit)', () => {
  // The worktree-switch reinit disposes the old checkout's chats (pi process +
  // store slice) and reopens fresh ones under the SAME panelId, so it must NOT
  // touch the registry entry the way disposeAgentPanel does.
  it('disposes each chat\'s pi + store slice without deleting the registry entry', () => {
    const storeDispose = vi.spyOn(useAgentStore.getState(), 'dispose')
    saveAgentPanelSession('panel-switch', {
      openChats: [{ agentKey: 'old-1', sessionFile: '/wt-x/s.jsonl', chatId: 'c-old-1' }],
      activeAgentKey: 'old-1',
      readyByKey: { 'old-1': true },
    })

    disposeAgentChats([
      { agentKey: 'old-1', sessionFile: '/wt-x/s.jsonl', chatId: 'c-old-1' },
      { agentKey: 'old-2', sessionFile: null, chatId: 'c-old-2' },
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

describe('resolvePanelChats (bug #1: two adoptions converge on ONE agentKey)', () => {
  it('resumes a dead chat under its recorded key, then a second adoption reuses it — no rival key, no second create', () => {
    const rootPath = '/repo'
    const chat = useChatsStore.getState().createCodingChat(rootPath, {
      agentKey: 'K', sessionFile: '/s.jsonl', title: 'shared',
    })

    // Panel A resolves first. The pi is not live yet, so the chat must be RESUMED
    // under its EXISTING key 'K' — never a freshly minted rival that would clobber
    // the durable record and strand a process on close.
    const planA = resolvePanelChats(rootPath, undefined)
    expect(planA.refs).toEqual([{ agentKey: 'K', sessionFile: '/s.jsonl', chatId: chat.id }])
    expect(planA.toResume.map((r) => r.agentKey)).toEqual(['K'])

    // Panel A creates the pi — the shared slice for 'K' becomes live.
    useAgentStore.getState().init('K')

    // Panel B resolves the SAME session. It is now live → adopt by REFERENCE with
    // the same key; toResume is empty, so there is NO second createAgent.
    const planB = resolvePanelChats(rootPath, undefined)
    expect(planB.refs).toEqual([{ agentKey: 'K', sessionFile: '/s.jsonl', chatId: chat.id }])
    expect(planB.toResume).toEqual([])
  })

  it('scopes the resolved chats to the panel\'s worktree tag', () => {
    const rootPath = '/repo'
    useChatsStore.getState().createCodingChat(rootPath, { agentKey: 'Kmain', sessionFile: '/m.jsonl', title: 'main' })
    useChatsStore.getState().createCodingChat(rootPath, { agentKey: 'Kwt', sessionFile: '/w.jsonl', worktreeId: 'wt-1', title: 'wt' })

    expect(resolvePanelChats(rootPath, undefined).refs.map((r) => r.agentKey)).toEqual(['Kmain'])
    expect(resolvePanelChats(rootPath, 'wt-1').refs.map((r) => r.agentKey)).toEqual(['Kwt'])
  })

  it('a closed panel reference does not strand the pi — it stays adoptable until an explicit delete', () => {
    const rootPath = '/repo'
    const chat = useChatsStore.getState().createCodingChat(rootPath, {
      agentKey: 'K', sessionFile: '/s.jsonl', title: 'shared',
    })
    useAgentStore.getState().init('K') // pi + slice live
    const storeDispose = vi.spyOn(useAgentStore.getState(), 'dispose')

    // Two panels reference the one durable chat.
    const ref = { agentKey: 'K', sessionFile: '/s.jsonl', chatId: chat.id }
    saveAgentPanelSession('panel-A', { openChats: [ref], activeAgentKey: 'K', readyByKey: { K: true } })
    saveAgentPanelSession('panel-B', { openChats: [ref], activeAgentKey: 'K', readyByKey: { K: true } })

    // Closing panel A drops only its references — the shared pi + record survive…
    disposeAgentPanel('panel-A')
    expect(agentDispose).not.toHaveBeenCalled()
    expect(storeDispose).not.toHaveBeenCalled()
    expect(useAgentStore.getState().panels['K']).toBeDefined()
    // …so panel B still adopts it by reference (nothing to re-create).
    expect(resolvePanelChats(rootPath, undefined).toResume).toEqual([])

    // Only an explicit delete disposes the pi + drops the durable record.
    disposeCodingChat(rootPath, chat.id)
    expect(agentDispose).toHaveBeenCalledWith('K')
    expect(useChatsStore.getState().getChat(rootPath, chat.id)).toBeUndefined()
  })
})

describe('beginAgentCreate (renderer create dedup)', () => {
  it('lets one create through per key and blocks a concurrent duplicate until released', () => {
    expect(beginAgentCreate('K')).toBe(true)  // first create claims the key
    expect(beginAgentCreate('K')).toBe(false) // a racing sibling mount is blocked
    endAgentCreate('K')
    expect(beginAgentCreate('K')).toBe(true)  // released → the next create may proceed
    endAgentCreate('K')
  })
})
