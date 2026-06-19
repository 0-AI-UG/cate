// =============================================================================
// agentSessionRegistry — durable per-panel chat bookkeeping, keyed by panelId.
//
// An AgentPanel hosts N pi chat sessions. The pi processes (keyed by agentKey
// in the main process) and their store slices (keyed by agentKey in
// useAgentStore) already outlive any single React mount. What does NOT survive
// a remount is the panel's local memory of *which* chats it owns and which is
// active — that lived in component state and was torn down on every unmount.
//
// Dragging a panel between a canvas node and a dock zone unmounts it in one
// React subtree and remounts it in another, so that local state (and, worse,
// the old code's dispose-on-unmount) wiped the live chat. This module mirrors
// the terminalRegistry pattern: keep the bookkeeping in a module-level map that
// outlives React, and tie teardown to the appStore panel-close paths rather
// than to component unmount.
// =============================================================================

import { useAgentStore } from './agentStore'

export interface OpenChat {
  /** Unique IPC session key — passed as `panelId` to AGENT_* IPC channels and
   *  used as the slice key in useAgentStore. Stable for the lifetime of the
   *  chat, even if the user renames or pi assigns a sessionFile later. */
  agentKey: string
  /** Pi's on-disk session file. Null for brand-new chats until pi's getState
   *  reports one (typically right after the first turn). */
  sessionFile: string | null
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

/** Dispose the pi process + store slice for each given chat, without touching
 *  any panel's registry entry. Shared by disposeAgentPanel (full teardown) and
 *  AgentPanel's worktree-switch reinit, which disposes the old checkout's chats
 *  and reopens fresh ones in the new checkout under the same panelId. */
export function disposeAgentChats(openChats: OpenChat[]): void {
  for (const chat of openChats) {
    window.electronAPI?.agentDispose(chat.agentKey).catch(() => { /* */ })
    useAgentStore.getState().dispose(chat.agentKey)
  }
}

/** Tear down every pi chat this panel ever spawned and drop its store slices.
 *  Called from the appStore close paths (closePanel / closeAllPanels /
 *  clearCanvas) and the cross-window detach handler — the same deterministic
 *  teardown points terminalRegistry.dispose() uses — NOT from React unmount, so
 *  a canvas<->dock remount keeps its chat alive. */
export function disposeAgentPanel(panelId: string): void {
  const session = sessions.get(panelId)
  if (!session) return
  sessions.delete(panelId)
  disposeAgentChats(session.openChats)
}
