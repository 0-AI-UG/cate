// What a client window shows, from the workspace list and the window's own
// state: one rule every shell renders and keeps its state to. A window shows
// a workspace only while it is in the list; otherwise it shows the welcome
// screen (no workspace at all, or none of the listed ones selected: never
// chosen, closed, or removed from the list, here or in another window).
// `reconcileWindow` brings the window's state back to what the rule can show
// whenever the list changes; views render `windowContent`.

import type { WorkspaceEntry, WorkspaceListSnapshot } from './workspaceList'

export type WindowContent =
  | { kind: 'workspace'; workspaceId: string }
  | { kind: 'welcome' }

export function windowContent(selectedId: string | null, entries: readonly WorkspaceEntry[]): WindowContent {
  return selectedId && entries.some((e) => e.id === selectedId) ? { kind: 'workspace', workspaceId: selectedId } : { kind: 'welcome' }
}

/** What a window shows after `removedId` left it (closed or removed): the
 *  next workspace still open in this client, or nothing. */
export function selectionAfter(removedId: string, open: readonly string[], entries: readonly WorkspaceEntry[]): string | null {
  return open.find((id) => id !== removedId && entries.some((e) => e.id === id)) ?? null
}

/** The workspaces a window's state names: the one it shows, and the one a
 *  dialog of it is about (Share). */
export interface WindowState {
  selected: string | null
  share: string | null
}

/** `state` with every workspace it names still listed: a selected one that
 *  left gives way to the next open one (or none), a dialog about one that
 *  left closes. Returns `state` itself when nothing changes. */
export function reconcileWindow(state: WindowState, list: WorkspaceListSnapshot): WindowState {
  const listed = (id: string | null) => id === null || list.entries.some((e) => e.id === id)
  if (listed(state.selected) && listed(state.share)) return state
  return {
    selected: listed(state.selected) ? state.selected : selectionAfter(state.selected!, list.open, list.entries),
    share: listed(state.share) ? state.share : null,
  }
}
