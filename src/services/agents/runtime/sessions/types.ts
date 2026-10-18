import type { AgentConversationMessage, AgentSessionLocator, UsageAgentLimits, UsageTokenTotals } from '../../contract'
import type { AgentId } from '../../contract'

export type { AgentSessionLocator }

/** Everything a CLI-specific store may use. `homeDir` belongs to the runtime's
 *  machine, where the agent CLIs keep their stores. */
export interface AgentSessionContext {
  session: AgentSessionLocator
  homeDir: string
}

/** One agent CLI's own session persistence, read-only. Both reads are
 *  best-effort: a missing, partial, or changing store resolves null. */
export interface AgentSessionStore {
  /** The title that CLI shows in its own session picker. */
  title(context: AgentSessionContext): Promise<string | null>
  /** The visible user/assistant turns, in conversation order. */
  conversation(context: AgentSessionContext): Promise<AgentConversationMessage[] | null>
  /** The files the conversation is read from, so a watcher can tell when it
   *  changed; empty while the session has none yet. */
  files?(context: AgentSessionContext): Promise<string[]>
  /** Where the CLI records token usage and how to read it. */
  usage: AgentUsage
}

/** One response's tokens as the CLI recorded them. */
export interface AgentUsageRecord {
  timestampMs: number
  model: string
  sessionId: string
  /** The session's working directory, which attributes it to a workspace;
   *  null when the store does not say (the record is then never counted). */
  cwd: string | null
  totals: UsageTokenTotals
  /** A cost the CLI recorded; null to price the tokens. */
  reportedCostUsd: number | null
  /** Repeats of one response share the key (the first one counts); null for
   *  a record that cannot repeat. */
  dedupeKey: string | null
}

/** Reads one transcript a line at a time. Its state is JSON, kept with the
 *  scan cache, so a transcript that grew resumes where the last scan stopped. */
export interface AgentUsageLineParser {
  /** Every line, in order; most yield nothing. */
  line(text: string): AgentUsageRecord[]
  state(): unknown
}

/** Which sessions a workspace counts, and the window asked for. */
export interface AgentUsageScope {
  sinceMs: number
  untilMs: number
  /** Whether a working directory is the workspace root or under it. */
  contains(cwd: string): Promise<boolean>
}

export type AgentUsageSource =
  /** Append-only JSONL transcripts under `root`, parsed incrementally and
   *  cached per file. `parser` resumes from a saved state, or returns null
   *  when that state is not one it wrote (the file is then parsed afresh). */
  | { kind: 'transcripts'; root(homeDir: string): string; fileName?: string; parser(file: string, state?: unknown): AgentUsageLineParser | null }
  /** A store queried for the window on every scan (null: unreadable). */
  | { kind: 'store'; location(homeDir: string): string; records(homeDir: string, sinceMs: number): Promise<AgentUsageRecord[] | null> }
  /** The CLI keeps no token counts; `note` says what it keeps instead. */
  | { kind: 'none'; location(homeDir: string): string; note(homeDir: string, scope: AgentUsageScope): Promise<string> }

export interface AgentUsage {
  source: AgentUsageSource
  /** The signed-in account's subscription windows, asked of the CLI without
   *  a prompt. Rejects with `CliMissingError` when the CLI is not installed. */
  limits?(probe: { cwd: string; env: NodeJS.ProcessEnv; now: Date }): Promise<UsageAgentLimits>
}

/** Exhaustive by design: adding a supported CLI must say where its sessions
 *  live instead of silently having no title or conversation. */
export type AgentSessionStores = Record<AgentId, AgentSessionStore>
