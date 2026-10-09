// The terminal panel's session channel: snapshot and ops (architecture 11.3).
// Output bytes do not travel on this channel: a view attaches to the terminal
// service's `process.attach` with the snapshot's `ptyId` (see session.ts).

import type { AgentId } from '@services/agents/contract'
import type { LaunchIntent, TerminalActivity } from '@services/terminal/contract'
import type { PanelCreateOptions } from '@panels/framework/contract'

export type TerminalPtyStatus = 'starting' | 'running' | 'exited' | 'failed'

export type TerminalSnapshot = {
  /** The live PTY a view attaches to; null before the first spawn. */
  ptyId: string | null
  status: TerminalPtyStatus
  /** The foreground program, else the shell's name. */
  title: string
  cwd: string | null
  activity: TerminalActivity
  exitCode: number | null
  /** Why the last spawn failed. */
  error: string | null
}

/** Input goes through the `process.attach` stream (views) or
 *  `cate terminal type / press` (callers), never a session op. */
export type TerminalOp =
  /** Kills the PTY; the screen stays readable. */
  | { kind: 'terminate' }
  /** A fresh shell in the panel's checkout. `dirty` while a program runs
   *  unless `discard`. */
  | { kind: 'restart'; discard?: boolean }
  /** Binds the panel to another checkout (null: the root) with a fresh shell. */
  | { kind: 'switchWorktree'; worktreeId: string | null; discard?: boolean }
  /** A clicked link the person chose to open inside Cate. */
  | { kind: 'openUrl'; url: string }
  | { kind: 'openFile'; path: string; line?: number; column?: number }


/** The terminal's own record fields. */
export type TerminalFields = {
  /** The directory the terminal was opened in. */
  cwd?: string
}

export interface TerminalCreateOptions extends PanelCreateOptions {
  cwd?: string
}

/** Where a clicked link goes. */
export type TerminalOpenTarget =
  | { kind: 'url'; url: string }
  | { kind: 'file'; path: string; line?: number; column?: number }

/** What the session persists in `sessions/<panelId>.json`. */
export type TerminalPersisted = {
  /** The last known cwd; a restored terminal reopens there. */
  cwd: string | null
  /** The agent session typed back as a resume command on restore. */
  stamp: { agentId: AgentId; sessionId: string; cwd: string; profile?: string } | null
}

export type { LaunchIntent }
