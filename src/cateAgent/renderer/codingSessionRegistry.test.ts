// Coverage for the inverted coding-chat ownership.
//
// SEMANTICS CHANGE (was: close disposes the pi session): the workspace (chatsStore)
// now OWNS coding chats durably, so they OUTLIVE the panel hosting them. Therefore:
//   - disposeCateAgentPanel (the appStore close / detach path) removes the panel's
//     REFERENCES only — it must NOT dispose the pi session or the store slice, and
//     it must NOT touch chats.json. A later mount re-adopts the still-live chat.
//   - disposeCodingChat is the ONLY disposer: an explicit chat delete disposes the
//     pi process + store slice AND drops the durable chats.json record.
//   - disposeCodingChats stays the worktree-switch reinit helper: dispose pi + slice
//     for the abandoned old-checkout chats, without touching the registry entry.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import {
  saveCateAgentPanelSession,
  getCateAgentPanelSession,
  disposeCateAgentPanel,
  disposeCodingChats,
  disposeCodingChat,
  resolvePanelChats,
  resumeCodingChat,
  beginCodingCreate,
  endCodingCreate,
} from './codingSessionRegistry'
import { useCodingStore } from './codingStore'
import { useChatsStore } from '../../renderer/stores/chatsStore'

// restoreMocks (vitest.config) wipes implementations before each test, so
// (re)install the electronAPI stubs' resolved-promise behaviour in beforeEach.
const agentDispose = vi.fn()
const projectChatsSave = vi.fn()
const agentCreate = vi.fn()
const agentLoadSessionMessages = vi.fn()

beforeEach(() => {
  agentDispose.mockReset().mockResolvedValue(undefined)
  projectChatsSave.mockReset().mockResolvedValue(undefined)
  agentCreate.mockReset().mockResolvedValue({ ok: true })
  agentLoadSessionMessages.mockReset().mockResolvedValue([])
  vi.stubGlobal('window', {
    electronAPI: { agentDispose, projectChatsSave, agentCreate, agentLoadSessionMessages },
  })
  // Module-level singletons: reset their state so tests don't leak into each other.
  useChatsStore.setState({ chatsByRoot: {}, loadedRoots: {} })
  useCodingStore.setState({ panels: {} })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('disposeCateAgentPanel (panel close = reference removal)', () => {
  it('removes the panel references but does NOT dispose the pi session or store slice', () => {
    const storeDispose = vi.spyOn(useCodingStore.getState(), 'dispose')
    saveCateAgentPanelSession('panel-1', {
      openChats: [
        { agentKey: 'k1', sessionFile: '/s1.jsonl', chatId: 'c1' },
        { agentKey: 'k2', sessionFile: null, chatId: 'c2' },
      ],
      activeAgentKey: 'k1',
      readyByKey: { k1: true, k2: true },
    })

    disposeCateAgentPanel('panel-1')

    // References gone…
    expect(getCateAgentPanelSession('panel-1')).toBeUndefined()
    // …but the chat's pi + slice are UNTOUCHED (the durable chat can be re-adopted).
    expect(agentDispose).not.toHaveBeenCalled()
    expect(storeDispose).not.toHaveBeenCalled()
  })

  it('is a no-op for an unknown panel', () => {
    disposeCateAgentPanel('does-not-exist')
    expect(agentDispose).not.toHaveBeenCalled()
  })
})

describe('disposeCodingChat (explicit delete = the only disposer)', () => {
  it('disposes the pi session + store slice AND removes the chats.json record', () => {
    const rootPath = '/repo'
    const storeDispose = vi.spyOn(useCodingStore.getState(), 'dispose')
    useCodingStore.getState().init('k9')
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

describe('disposeCodingChats (worktree-switch reinit)', () => {
  // The worktree-switch reinit disposes the old checkout's chats (pi process +
  // store slice) and reopens fresh ones under the SAME panelId, so it must NOT
  // touch the registry entry the way disposeCateAgentPanel does.
  it('disposes each chat\'s pi + store slice without deleting the registry entry', () => {
    const storeDispose = vi.spyOn(useCodingStore.getState(), 'dispose')
    saveCateAgentPanelSession('panel-switch', {
      openChats: [{ agentKey: 'old-1', sessionFile: '/wt-x/s.jsonl', chatId: 'c-old-1' }],
      activeAgentKey: 'old-1',
      readyByKey: { 'old-1': true },
    })

    disposeCodingChats([
      { agentKey: 'old-1', sessionFile: '/wt-x/s.jsonl', chatId: 'c-old-1' },
      { agentKey: 'old-2', sessionFile: null, chatId: 'c-old-2' },
    ])

    expect(agentDispose).toHaveBeenCalledTimes(2)
    expect(agentDispose).toHaveBeenCalledWith('old-1')
    expect(agentDispose).toHaveBeenCalledWith('old-2')
    expect(storeDispose).toHaveBeenCalledWith('old-1')
    expect(storeDispose).toHaveBeenCalledWith('old-2')
    // Registry entry survives — the panel lives on and reopens in the new cwd.
    expect(getCateAgentPanelSession('panel-switch')).toBeDefined()
  })

  it('is a no-op for an empty chat list', () => {
    disposeCodingChats([])
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
    useCodingStore.getState().init('K')

    // Panel B resolves the SAME session. It is now live → adopt by REFERENCE with
    // the same key; toResume is empty, so there is NO second createCateAgent.
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
    useCodingStore.getState().init('K') // pi + slice live
    const storeDispose = vi.spyOn(useCodingStore.getState(), 'dispose')

    // Two panels reference the one durable chat.
    const ref = { agentKey: 'K', sessionFile: '/s.jsonl', chatId: chat.id }
    saveCateAgentPanelSession('panel-A', { openChats: [ref], activeAgentKey: 'K', readyByKey: { K: true } })
    saveCateAgentPanelSession('panel-B', { openChats: [ref], activeAgentKey: 'K', readyByKey: { K: true } })

    // Closing panel A drops only its references — the shared pi + record survive…
    disposeCateAgentPanel('panel-A')
    expect(agentDispose).not.toHaveBeenCalled()
    expect(storeDispose).not.toHaveBeenCalled()
    expect(useCodingStore.getState().panels['K']).toBeDefined()
    // …so panel B still adopts it by reference (nothing to re-create).
    expect(resolvePanelChats(rootPath, undefined).toResume).toEqual([])

    // Only an explicit delete disposes the pi + drops the durable record.
    disposeCodingChat(rootPath, chat.id)
    expect(agentDispose).toHaveBeenCalledWith('K')
    expect(useChatsStore.getState().getChat(rootPath, chat.id)).toBeUndefined()
  })
})

describe('resumeCodingChat (shared dead-chat resume path)', () => {
  it('inits the slice, replays the transcript, and respawns pi under the EXISTING key + given cwd', async () => {
    const rootPath = '/repo'
    const model = { provider: 'anthropic', model: 'claude' }
    const transcript = [{ id: 'm1', type: 'user', text: 'hi' }]
    agentLoadSessionMessages.mockResolvedValue(transcript)
    const chat = useChatsStore.getState().createCodingChat(rootPath, {
      agentKey: 'K-dead', sessionFile: '/sessions/s.jsonl', model, title: 'resume me',
    })
    // Slice is DEAD (never inited) — the app-restart / closed-panel case.
    expect(useCodingStore.getState().panels['K-dead']).toBeUndefined()

    const ok = await resumeCodingChat(rootPath, chat.id, '/repo/wt-x', 'ws-1')

    expect(ok).toBe(true)
    // Slice inited, model applied, transcript replayed.
    const slice = useCodingStore.getState().panels['K-dead']
    expect(slice).toBeDefined()
    expect(slice?.model).toEqual(model)
    expect(slice?.messages).toEqual(transcript)
    expect(agentLoadSessionMessages).toHaveBeenCalledWith('/sessions/s.jsonl')
    // pi respawned under the EXISTING agentKey, in the caller-resolved cwd, resuming
    // the same on-disk session.
    expect(agentCreate).toHaveBeenCalledTimes(1)
    expect(agentCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        panelId: 'K-dead',
        workspaceId: 'ws-1',
        cwd: '/repo/wt-x',
        sessionFile: '/sessions/s.jsonl',
        model,
      }),
    )
  })

  it('no-ops when the slice is already live — adopt by reference, no second create', async () => {
    const rootPath = '/repo'
    const chat = useChatsStore.getState().createCodingChat(rootPath, {
      agentKey: 'K-live', sessionFile: '/s.jsonl', title: 'live',
    })
    useCodingStore.getState().init('K-live') // pi + slice already running

    const ok = await resumeCodingChat(rootPath, chat.id, '/repo', 'ws-1')

    expect(ok).toBe(true)
    expect(agentLoadSessionMessages).not.toHaveBeenCalled()
    expect(agentCreate).not.toHaveBeenCalled()
  })

  it('is a no-op for a chat with no agentKey (unresumable) and an unknown chat', async () => {
    expect(await resumeCodingChat('/repo', 'nope', '/repo', 'ws-1')).toBe(true)
    expect(agentCreate).not.toHaveBeenCalled()
  })
})

describe('beginCodingCreate (renderer create dedup)', () => {
  it('lets one create through per key and blocks a concurrent duplicate until released', () => {
    expect(beginCodingCreate('K')).toBe(true)  // first create claims the key
    expect(beginCodingCreate('K')).toBe(false) // a racing sibling mount is blocked
    endCodingCreate('K')
    expect(beginCodingCreate('K')).toBe(true)  // released → the next create may proceed
    endCodingCreate('K')
  })
})
