// =============================================================================
// chatsStore — renderer-side authority for per-workspace Cate Agent chats.
//
// Holds the live chat list keyed by project rootPath, and mirrors every mutation
// to `.cate/chats.json` via IPC. Keyed by root (not the single selected workspace)
// so multiple open workspaces keep independent threads and a re-select doesn't
// reload. A chat is a persistent thread of typed messages plus the live/last `run`
// state for a code/canvas task; the controller drives the run, this store persists.
// =============================================================================

import { create } from 'zustand'
import type { AgentModelRef, Chat, ChatMessage, ChatMode, ChatRun } from '../../shared/types'
import { generateId } from './canvas/helpers'

/** A chat's engine, defaulting a legacy (mode-less) record to 'loop'. The single
 *  place the missing-mode back-compat rule is applied; every read site goes
 *  through here or getChatsByMode. */
export function chatMode(chat: Chat): ChatMode {
  return chat.mode ?? 'loop'
}

/** The status dot colour a chat's run carries in the sidebar/tab lists. */
export function chatDotColor(chat: Chat): string {
  if (chat.run?.status === 'running') return '#4ade80'
  if (chat.run?.interrupted || chat.run?.status === 'review') return '#fbbf24'
  if (chat.run?.status === 'failed') return '#f87171'
  return 'var(--surface-5)'
}

/** Fields a coding chat is born with. Its transcript is NOT stored here — the pi
 *  turns live in useAgentStore, reloaded from `sessionFile`; `messages` stays []. */
export interface CreateCodingChatInput {
  agentKey: string
  sessionFile: string | null
  worktreeId?: string
  model?: AgentModelRef
  title: string
}

interface ChatsStoreState {
  /** Chats per project rootPath, oldest first. */
  chatsByRoot: Record<string, Chat[]>
  /** Roots whose list has been loaded from disk at least once. */
  loadedRoots: Record<string, boolean>
}

interface ChatsStoreActions {
  /** Load `.cate/chats.json` for a root once; re-calls are cheap no-ops unless forced. */
  loadChats: (rootPath: string, force?: boolean) => Promise<void>
  /** Read the current list for a root (already-loaded; [] otherwise). */
  getChats: (rootPath: string) => Chat[]
  /** Read the current list for a root filtered to one engine (mode-less → 'loop'). */
  getChatsByMode: (rootPath: string, mode: ChatMode) => Chat[]
  /** Find one chat by id (undefined if absent). */
  getChat: (rootPath: string, id: string) => Chat | undefined
  /** Create a fresh empty loop chat with the given title and persist it. */
  createChat: (rootPath: string, title: string) => Chat
  /** Create a durable coding chat (references a pi session) and persist it. */
  createCodingChat: (rootPath: string, input: CreateCodingChatInput) => Chat
  /** Patch a coding chat's reference fields (sessionFile/model/worktree/title/
   *  agentKey) and persist. Bumps updatedAt so recents order by activity. */
  updateCodingChat: (rootPath: string, id: string, patch: Partial<Pick<Chat, 'sessionFile' | 'model' | 'worktreeId' | 'title' | 'agentKey'>>) => void
  /** Set a chat's per-chat model override (either mode) and persist. null clears
   *  it, falling the chat back to the global default. */
  setChatModel: (rootPath: string, id: string, model: AgentModelRef | null) => void
  /** Remove a chat (either mode) and persist. */
  removeChat: (rootPath: string, id: string) => void
  /** Append one typed message to a chat and persist. */
  appendMessage: (rootPath: string, id: string, message: ChatMessage) => void
  /** Patch one message by id (merge) and persist. */
  patchMessage: (rootPath: string, id: string, messageId: string, patch: Partial<ChatMessage>) => void
  /** Read a chat's run (undefined if none). */
  getRun: (rootPath: string, id: string) => ChatRun | undefined
  /** Patch a chat's run (creating it if absent) and persist. */
  patchRun: (rootPath: string, id: string, patch: Partial<ChatRun>) => void
  /** Drop a chat's run entirely (a question turn / after landing) and persist. */
  clearRun: (rootPath: string, id: string) => void
}

export type ChatsStore = ChatsStoreState & ChatsStoreActions

/** Persist a root's list to disk. Fire-and-forget; main does the atomic write. */
function persist(rootPath: string, chats: Chat[]): void {
  void window.electronAPI.projectChatsSave(rootPath, chats)
}

/** Immutably replace one chat in a root's list, stamping updatedAt. */
function withChat(list: Chat[], id: string, fn: (chat: Chat) => Chat): Chat[] {
  return list.map((c) => (c.id === id ? { ...fn(c), updatedAt: Date.now() } : c))
}

export const useChatsStore = create<ChatsStore>((set, get) => ({
  chatsByRoot: {},
  loadedRoots: {},

  async loadChats(rootPath, force = false) {
    if (!rootPath) return
    if (!force && get().loadedRoots[rootPath]) return
    const chats = await window.electronAPI.projectChatsLoad(rootPath)
    set((s) => ({
      chatsByRoot: { ...s.chatsByRoot, [rootPath]: chats },
      loadedRoots: { ...s.loadedRoots, [rootPath]: true },
    }))
  },

  getChats(rootPath) {
    return get().chatsByRoot[rootPath] ?? []
  },

  getChatsByMode(rootPath, mode) {
    return (get().chatsByRoot[rootPath] ?? []).filter((c) => chatMode(c) === mode)
  },

  getChat(rootPath, id) {
    return (get().chatsByRoot[rootPath] ?? []).find((c) => c.id === id)
  },

  createChat(rootPath, title) {
    const now = Date.now()
    const chat: Chat = { id: generateId(), title: title.slice(0, 80) || 'New chat', createdAt: now, updatedAt: now, messages: [], mode: 'loop' }
    const next = [...(get().chatsByRoot[rootPath] ?? []), chat]
    set((s) => ({
      chatsByRoot: { ...s.chatsByRoot, [rootPath]: next },
      loadedRoots: { ...s.loadedRoots, [rootPath]: true },
    }))
    persist(rootPath, next)
    return chat
  },

  createCodingChat(rootPath, input) {
    const now = Date.now()
    const chat: Chat = {
      id: generateId(),
      title: input.title.slice(0, 80) || 'New chat',
      createdAt: now,
      updatedAt: now,
      messages: [],
      mode: 'coding',
      agentKey: input.agentKey,
      sessionFile: input.sessionFile,
      ...(input.worktreeId ? { worktreeId: input.worktreeId } : {}),
      ...(input.model ? { model: input.model } : {}),
    }
    const next = [...(get().chatsByRoot[rootPath] ?? []), chat]
    set((s) => ({
      chatsByRoot: { ...s.chatsByRoot, [rootPath]: next },
      loadedRoots: { ...s.loadedRoots, [rootPath]: true },
    }))
    persist(rootPath, next)
    return chat
  },

  updateCodingChat(rootPath, id, patch) {
    const current = get().chatsByRoot[rootPath]
    if (!current) return
    const next = withChat(current, id, (c) => ({ ...c, ...patch }))
    set((s) => ({ chatsByRoot: { ...s.chatsByRoot, [rootPath]: next } }))
    persist(rootPath, next)
  },

  setChatModel(rootPath, id, model) {
    const current = get().chatsByRoot[rootPath]
    if (!current) return
    const next = withChat(current, id, (c) => ({ ...c, model: model ?? undefined }))
    set((s) => ({ chatsByRoot: { ...s.chatsByRoot, [rootPath]: next } }))
    persist(rootPath, next)
  },

  removeChat(rootPath, id) {
    const current = get().chatsByRoot[rootPath]
    if (!current) return
    const next = current.filter((c) => c.id !== id)
    set((s) => ({ chatsByRoot: { ...s.chatsByRoot, [rootPath]: next } }))
    persist(rootPath, next)
  },

  appendMessage(rootPath, id, message) {
    const current = get().chatsByRoot[rootPath]
    if (!current) return
    const next = withChat(current, id, (c) => ({ ...c, messages: [...c.messages, message] }))
    set((s) => ({ chatsByRoot: { ...s.chatsByRoot, [rootPath]: next } }))
    persist(rootPath, next)
  },

  patchMessage(rootPath, id, messageId, patch) {
    const current = get().chatsByRoot[rootPath]
    if (!current) return
    const next = withChat(current, id, (c) => ({
      ...c,
      messages: c.messages.map((m) => (m.id === messageId ? ({ ...m, ...patch } as ChatMessage) : m)),
    }))
    set((s) => ({ chatsByRoot: { ...s.chatsByRoot, [rootPath]: next } }))
    persist(rootPath, next)
  },

  getRun(rootPath, id) {
    return get().getChat(rootPath, id)?.run
  },

  patchRun(rootPath, id, patch) {
    const current = get().chatsByRoot[rootPath]
    if (!current) return
    const next = withChat(current, id, (c) => ({ ...c, run: { status: 'running', ...c.run, ...patch } }))
    set((s) => ({ chatsByRoot: { ...s.chatsByRoot, [rootPath]: next } }))
    persist(rootPath, next)
  },

  clearRun(rootPath, id) {
    const current = get().chatsByRoot[rootPath]
    if (!current) return
    const next = withChat(current, id, (c) => ({ ...c, run: undefined }))
    set((s) => ({ chatsByRoot: { ...s.chatsByRoot, [rootPath]: next } }))
    persist(rootPath, next)
  },
}))
