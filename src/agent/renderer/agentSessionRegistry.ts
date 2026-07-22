// =============================================================================
// agentSessionRegistry — per-panel VIEW STATE for coding chats, keyed by panelId.
//
// Ownership was inverted: the workspace (chatsStore, keyed by rootPath) now OWNS
// coding chats durably in `.cate/chats.json`, so they outlive the panel hosting
// them. This module holds only a panel's *references* — which chats it currently
// shows and which is active — never the chat data or the disposal responsibility.
//
// The pi processes (keyed by agentKey in the main process) and their store slices
// (keyed by agentKey in useAgentStore) already outlive any single React mount.
// What did NOT survive a remount is a panel's local memory of which chats it
// shows — that lived in component state. Dragging a panel between a canvas node
// and a dock zone unmounts it in one React subtree and remounts it in another, so
// that local state was lost. This map, like terminalRegistry, keeps the
// bookkeeping alive across a remount.
//
// SEMANTICS CHANGE: closing a panel (disposeAgentPanel) now removes the panel's
// references ONLY — it does NOT dispose the pi session or the store slice; the
// chat lives on in chatsStore and can be re-adopted. The ONLY disposer is an
// explicit chat delete (disposeCodingChat).
// =============================================================================

import { useAgentStore } from './agentStore'
import { useChatsStore } from '../../renderer/stores/chatsStore'

export interface OpenChat {
  /** Unique IPC session key — passed as `panelId` to AGENT_* IPC channels and
   *  used as the slice key in useAgentStore. Stable for the lifetime of the
   *  chat, even if the user renames or pi assigns a sessionFile later. */
  agentKey: string
  /** Pi's on-disk session file. Null for brand-new chats until pi's getState
   *  reports one (typically right after the first turn). */
  sessionFile: string | null
  /** The durable chatsStore chat this reference points at. The workspace owns the
   *  chat; the panel only borrows it. */
  chatId: string
}

export interface AgentPanelSession {
  openChats: OpenChat[]
  activeAgentKey: string | null
  /** Per-chat pi-readiness snapshot so a re-adopting mount doesn't re-gate its
   *  polling effects behind a fresh (empty) readiness map. */
  readyByKey: Record<string, boolean>
}

const sessions = new Map<string, AgentPanelSession>()

export function getAgentPanelSession(panelId: string): AgentPanelSession | undefined {
  return sessions.get(panelId)
}

/** Mirror the panel's live bookkeeping. Called on every change (not just at
 *  unmount) so a remount always re-adopts a fresh snapshot. */
export function saveAgentPanelSession(panelId: string, session: AgentPanelSession): void {
  sessions.set(panelId, session)
}

export interface PanelChatsPlan {
  /** Every durable coding chat this checkout owns, as panel references, in the
   *  chatsStore's order. What the panel shows for its cwd. */
  refs: OpenChat[]
  /** The subset of `refs` whose pi slice is NOT live and must be resumed via
   *  createAgent — under their EXISTING agentKey, never a freshly minted one. */
  toResume: OpenChat[]
}

/** Resolve which durable coding chats a panel shows for its worktree, and which
 *  of them need their pi (re)started.
 *
 *  The ownership model: chatsStore (keyed by rootPath) durably owns coding chats,
 *  each pinned to an `agentKey`. A live chat — one whose slice is already in
 *  useAgentStore because its pi survived a panel close or a sibling panel started
 *  it — is adopted by REFERENCE (no createAgent). A dead one is resumed under its
 *  recorded agentKey, so two panels resolving the same session converge on ONE pi
 *  instead of minting rival keys that would strand a process on close. */
export function resolvePanelChats(rootPath: string, worktreeId: string | undefined): PanelChatsPlan {
  const store = useAgentStore.getState()
  const chats = useChatsStore.getState()
    .getChatsByMode(rootPath, 'coding')
    .filter((c) => (c.worktreeId ?? undefined) === (worktreeId ?? undefined))
  const refs: OpenChat[] = []
  const toResume: OpenChat[] = []
  for (const c of chats) {
    if (!c.agentKey) continue
    const ref: OpenChat = { agentKey: c.agentKey, sessionFile: c.sessionFile ?? null, chatId: c.id }
    refs.push(ref)
    if (!store.panels[c.agentKey]) toResume.push(ref)
  }
  return { refs, toResume }
}

// Guards against two near-simultaneous mounts (e.g. two panels resolving the same
// not-yet-live session) both firing AGENT_CREATE for one agentKey. Main is also
// idempotent per key (belt and suspenders); this just avoids the redundant IPC.
const creatingKeys = new Set<string>()

/** Claim the right to createAgent for `key`. Returns false if a create for this
 *  key is already in flight — the caller should skip its create and let the
 *  in-flight one bring the shared slice to ready. Pair with endAgentCreate. */
export function beginAgentCreate(key: string): boolean {
  if (creatingKeys.has(key)) return false
  creatingKeys.add(key)
  return true
}

export function endAgentCreate(key: string): void {
  creatingKeys.delete(key)
}

/** Dispose the pi process + store slice for each given chat, without touching any
 *  panel's registry entry or its chatsStore record. Used by AgentPanel's
 *  worktree-switch reinit, which abandons the old checkout's pi sessions (and
 *  drops their durable chats itself) before reopening fresh ones in the new
 *  checkout under the same panelId. */
export function disposeAgentChats(openChats: OpenChat[]): void {
  for (const chat of openChats) {
    window.electronAPI?.agentDispose(chat.agentKey).catch(() => { /* */ })
    useAgentStore.getState().dispose(chat.agentKey)
  }
}

/** Remove a panel's coding-chat references. Called from the appStore close paths
 *  (closePanel / closeAllPanels / clearCanvas) and the cross-window detach
 *  handler — NOT from React unmount, so a canvas<->dock remount keeps its refs.
 *
 *  New semantics: this is a REFERENCE removal only. The pi sessions and store
 *  slices stay alive and the chats stay in chatsStore, so a later mount (or
 *  another panel in the same workspace) can re-adopt them. Disposal happens ONLY
 *  on an explicit chat delete, via disposeCodingChat. */
export function disposeAgentPanel(panelId: string): void {
  sessions.delete(panelId)
}

/** Explicitly delete a coding chat: dispose its pi process + store slice AND drop
 *  its durable chatsStore record (which persists chats.json). The single disposer
 *  in the inverted model — a panel close never lands here. Does NOT delete pi's
 *  on-disk session file, so the thread remains resumable from the recents list. */
export function disposeCodingChat(rootPath: string, chatId: string): void {
  const chat = useChatsStore.getState().getChat(rootPath, chatId)
  if (chat?.agentKey) {
    window.electronAPI?.agentDispose(chat.agentKey).catch(() => { /* */ })
    useAgentStore.getState().dispose(chat.agentKey)
  }
  useChatsStore.getState().removeChat(rootPath, chatId)
}
