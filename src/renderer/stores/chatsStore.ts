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
import type { CateAgentModelRef, Chat, ChatMessage, ChatRun } from '../../shared/types'
import { generateId } from './canvas/helpers'

/** The status dot colour a chat's run carries in the sidebar/tab lists. */
export function chatDotColor(chat: Chat): string {
  if (chat.run?.status === 'running') return '#4ade80'
  if (chat.run?.interrupted || chat.run?.status === 'review') return '#fbbf24'
  if (chat.run?.status === 'failed') return '#f87171'
  return 'var(--surface-5)'
}

/** Legacy chats have no hostPanelId, which deliberately makes the sidebar their
 * owner without a file-format migration. */
export function isSidebarChat(chat: Chat): boolean {
  return !chat.hostPanelId
}

export function isPanelChat(chat: Chat, panelId: string): boolean {
  return chat.hostPanelId === panelId
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
  /** Find one chat by id (undefined if absent). */
  getChat: (rootPath: string, id: string) => Chat | undefined
  /** Create a fresh empty Cate Agent chat in the sidebar (default) or one panel. */
  createChat: (rootPath: string, title: string, hostPanelId?: string) => Chat
  /** Move one chat to an Agent panel, or to the sidebar when panelId is null. */
  moveChat: (rootPath: string, id: string, panelId: string | null) => void
  /** Return every chat owned by any of these closing panels to the sidebar. */
  releasePanelChats: (rootPath: string, panelIds: Iterable<string>) => void
  /** Set a chat's per-chat model override and persist. null clears
   *  it, falling the chat back to the global default. */
  setChatModel: (rootPath: string, id: string, model: CateAgentModelRef | null) => void
  /** Patch durable chat metadata (direct-session file, title, engineering handoff). */
  patchChat: (rootPath: string, id: string, patch: Partial<Chat>) => void
  /** Remove a chat and persist. */
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

/** Coalesce panel/sidebar mounts that request the same root concurrently. Besides
 * avoiding duplicate IPC, this prevents a late stale load from undoing a chat
 * ownership move performed after the first load resolves. */
const pendingLoads = new Map<string, Promise<void>>()

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
    const pending = pendingLoads.get(rootPath)
    if (pending) return pending
    const load = window.electronAPI.projectChatsLoad(rootPath).then((chats) => {
      set((s) => ({
        chatsByRoot: { ...s.chatsByRoot, [rootPath]: chats },
        loadedRoots: { ...s.loadedRoots, [rootPath]: true },
      }))
    })
    pendingLoads.set(rootPath, load)
    try {
      await load
    } finally {
      if (pendingLoads.get(rootPath) === load) pendingLoads.delete(rootPath)
    }
  },

  getChats(rootPath) {
    return get().chatsByRoot[rootPath] ?? []
  },

  getChat(rootPath, id) {
    return (get().chatsByRoot[rootPath] ?? []).find((c) => c.id === id)
  },

  createChat(rootPath, title, hostPanelId) {
    const now = Date.now()
    const chat: Chat = {
      id: generateId(),
      title: title.slice(0, 80) || 'New chat',
      createdAt: now,
      updatedAt: now,
      messages: [],
      ...(hostPanelId ? { hostPanelId } : {}),
    }
    const next = [...(get().chatsByRoot[rootPath] ?? []), chat]
    set((s) => ({
      chatsByRoot: { ...s.chatsByRoot, [rootPath]: next },
      loadedRoots: { ...s.loadedRoots, [rootPath]: true },
    }))
    persist(rootPath, next)
    return chat
  },

  moveChat(rootPath, id, panelId) {
    const current = get().chatsByRoot[rootPath]
    if (!current) return
    const target = current.find((chat) => chat.id === id)
    if (!target || (target.hostPanelId ?? null) === panelId) return
    const next = withChat(current, id, (chat) => ({
      ...chat,
      hostPanelId: panelId ?? undefined,
    }))
    set((s) => ({ chatsByRoot: { ...s.chatsByRoot, [rootPath]: next } }))
    persist(rootPath, next)
  },

  releasePanelChats(rootPath, panelIds) {
    const current = get().chatsByRoot[rootPath]
    if (!current) return
    const closing = new Set(panelIds)
    if (!current.some((chat) => chat.hostPanelId && closing.has(chat.hostPanelId))) return
    const now = Date.now()
    const next = current.map((chat) => (
      chat.hostPanelId && closing.has(chat.hostPanelId)
        ? { ...chat, hostPanelId: undefined, updatedAt: now }
        : chat
    ))
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

  patchChat(rootPath, id, patch) {
    const current = get().chatsByRoot[rootPath]
    if (!current) return
    const next = withChat(current, id, (chat) => ({ ...chat, ...patch, id: chat.id }))
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

/** Close lifecycle adapter. A mounted Agent panel already has chats loaded, but
 * cold/restored panels can be closed before mounting; load in that case so their
 * chats are not left pinned to a panel id that no longer exists. */
export function releasePanelChatsToSidebar(rootPath: string, panelIds: Iterable<string>): void {
  if (!rootPath) return
  const ids = [...panelIds]
  if (ids.length === 0) return
  const store = useChatsStore.getState()
  if (store.loadedRoots[rootPath]) {
    store.releasePanelChats(rootPath, ids)
    return
  }
  void store.loadChats(rootPath)
    .then(() => useChatsStore.getState().releasePanelChats(rootPath, ids))
    .catch(() => {
      // Closing the panel must still succeed if its workspace is unavailable.
    })
}
