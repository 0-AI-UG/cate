// The chat panel (architecture 11.3): a T3 conversation in its checkout's
// harness, shown by the T3 client in a webview. Snapshot and op types. Pure.

import type { T3ThreadActivity } from '@services/t3/contract'
import type { PanelCreateOptions } from '@panels/framework/contract'
import type { PanelRecord, PlaceTarget } from '@workspace/document/contract'

/** The record fields of a chat panel. `cwd` is an explicit checkout (else the
 *  panel's worktree, else the root); `threadId` the conversation shown (none:
 *  a fresh chat whose first prompt creates it). */
export interface ChatFields {
  threadId?: string
  cwd?: string
}

export function chatThreadId(record: PanelRecord): string | undefined {
  const threadId = record.fields.threadId
  return typeof threadId === 'string' && threadId ? threadId : undefined
}

/** Where the view loads the harness. The page stays on the runtime's machine
 *  (`http://127.0.0.1:<port>`); clients reach it through loopback routing. */
export type ChatHarness = {
  origin: string
  port: number
  /** Stable across harness restarts (the checkout's hash). */
  instanceId: string
  environmentId: string
  /** T3's session cookie, installed in the partition before loading. */
  session: { name: string; value: string }
}

/** The harness page of a binding: the thread's page, or the home page. */
export function chatPageUrl(harness: ChatHarness, threadId: string | null): string {
  return threadId
    ? `${harness.origin}/${encodeURIComponent(harness.environmentId)}/${encodeURIComponent(threadId)}`
    : `${harness.origin}/`
}

/** Files one turn changed that are still changed in the checkout. */
export type ChatTurnChange = { path: string; kind: 'modified'; additions: number; deletions: number }
export type ChatChanges = { threadId: string; turns: Record<string, ChatTurnChange[]> }

export type ChatPhase = 'loading' | 'ready' | 'error'

export type ChatSnapshot = {
  /** The checkout the conversation belongs to. */
  checkout: string
  threadId: string | null
  phase: ChatPhase
  error: string | null
  harness: ChatHarness | null
  /** Increases whenever the view must load the page afresh (a new binding, a
   *  restarted harness). A thread the page created itself does not reload. */
  loadId: number
  /** The harness's thread-shell stream; null until reported. */
  connected: boolean | null
  activity: T3ThreadActivity | null
  /** The agent running the thread ("T3 Code" until its provider is known). */
  agentName: string | null
  canReceivePrompt: boolean
  changes: ChatChanges | null
}

export type ChatOp =
  /** Restarts the checkout's harness and loads again. */
  | { kind: 'retry' }
  /** Moves the panel to another checkout (null: the workspace root); its
   *  conversation stays behind with the old one. */
  | { kind: 'switchWorktree'; worktreeId: string | null; discard?: boolean }
  /** Shows another conversation (null: a fresh chat); the page reloads.
   *  Ignored when `checkout` no longer is the panel's checkout. */
  | { kind: 'selectThread'; threadId: string | null; title?: string; checkout?: string }
  /** The page itself created or opened a conversation: record it without
   *  reloading. */
  | { kind: 'adoptThread'; threadId: string | null }
  | { kind: 'renameConversation'; title: string }
  /** The view failed to load the page of `loadId`. */
  | { kind: 'loadFailed'; loadId: number; message: string }
  /** Submits a prompt as the user would. */
  /** Relation context for a turn the page composer sends. */
  | { kind: 'relationContext'; provider: string | null }
  /** Guest bridge actions after the user picked a place. `threadId` is the
   *  binding the request came from; a stale one is refused. */
  | { kind: 'openFile'; path: string; at: PlaceTarget; threadId?: string }
  | { kind: 'openChanges'; at: PlaceTarget; filePath?: string; turnId?: string; threadId?: string }
  | { kind: 'openChat'; at: PlaceTarget; threadId: string; title?: string }

/** A chat panel at `cwd` (else its worktree or the root), on `threadId` when
 *  given (else a fresh chat). */
export interface ChatCreateOptions extends PanelCreateOptions {
  threadId?: string
  cwd?: string
}

/** Page operations the session asks the driving client for. */
export const CHAT_SURFACE_SEND_TEXT = 'chat.sendText'

export const CHAT_DEFAULT_TITLE = 'T3 Code'
