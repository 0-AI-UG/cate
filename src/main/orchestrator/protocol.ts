// =============================================================================
// Orchestrator protocol — JSON envelopes exchanged between the `cate` CLI and
// the main-process socket server. Kept in a separate module so both sides can
// type-check against the same shape (the CLI declares its own minimal copy to
// stay zero-dep, but should stay in sync with this file).
// =============================================================================

export interface OrchTerminalInfo {
  /** Stable PTY id (terminal-...) — used as the address inside the orchestrator. */
  ptyId: string
  /** Renderer panel id. */
  panelId: string
  /** Canvas node id, if this terminal is currently on a canvas. */
  nodeId: string | null
  /** Display name used by `cate ask` / `cate list`. Mirrors PanelState.title. */
  name: string
  /** True for the terminal that issued the request. */
  self?: boolean
}

export interface OrchRequest {
  id: number
  command: string
  args?: Record<string, unknown>
  /** Caller's terminal id (from CATE_TERMINAL_ID env). May be empty if invoked
   *  outside a Cate-managed PTY, in which case some commands reject. */
  callerTerminalId: string
}

export type OrchResponse =
  | { id: number; ok: true; data: unknown }
  | { id: number; ok: false; error: string; code?: string }

// -- Command payloads --

export interface ListResult {
  self: OrchTerminalInfo | null
  peers: OrchTerminalInfo[]
  /** True once Phase B ships connections — peers reflect only those reachable
   *  via the canvas connection graph. False during Phase A: peers are all
   *  terminals in the caller's window. */
  graphAware: boolean
}

export interface CheckArgs { name: string; lines?: number }
export interface CheckResult { name: string; output: string }

export interface AskArgs { name: string; prompt: string; settlingMs?: number; maxWaitMs?: number }
export interface AskResult { name: string; response: string }

export interface WhoamiResult { self: OrchTerminalInfo | null }

// -- Phase D command payloads --

export interface RecruitArgs {
  name: string
  preset?: string
  role?: string
  command?: string
}
export interface RecruitResult {
  name: string
  panelId: string
  nodeId: string | null
  preset: string
  preStartedCommand: string | null
}

export interface DismissArgs { name: string }
export interface DismissResult { name: string; closed: boolean }

export interface ConnectArgs { from: string; to: string }
export interface ConnectResult { connectionId: string }

export interface DisconnectArgs { from: string; to: string }
export interface DisconnectResult { removed: boolean }

export interface PresetListResult {
  presets: Array<{ name: string; command: string; agentKind: string; available: boolean }>
}

export interface RoleListResult { roles: Array<{ id: string; name: string }> }
export interface RoleCreateArgs { name: string; prompt: string }
export interface RoleEditArgs { name: string; prompt: string }
export interface RoleAssignArgs { recruit: string; role: string | null }
export interface RoleResult { name: string }

export interface NoteCreateArgs { content?: string }
export interface NoteReadArgs { name: string; startLine?: number; numLines?: number }
export interface NoteWriteArgs { name: string; content: string }
export interface NoteEditArgs { name: string; oldText: string; newText: string }
export interface NoteResult { name: string; content?: string; bytes?: number; occurrences?: number }
export interface NoteListResult { notes: Array<{ id: string; name: string }> }

export interface PortalCreateArgs { url: string; name?: string }
export interface PortalCreateResult { name: string; panelId: string; nodeId: string | null }
export interface PortalNameArgs { name: string }
export interface PortalEditArgs { name: string; url: string }
export interface PortalSelector { name: string; selector: string }
export interface PortalFillArgs extends PortalSelector { value: string }
export interface PortalTypeArgs { name: string; selector?: string; text: string }
export interface PortalKeyArgs { name: string; key: string }
export interface PortalSelectArgs extends PortalSelector { option: string }
export interface PortalScrollArgs { name: string; direction: 'up' | 'down' | 'left' | 'right'; distance: number; selector?: string }
export interface PortalScreenshotResult { name: string; path: string }
export interface PortalEvaluateArgs { name: string; expression: string }
export interface PortalEvaluateResult { name: string; result: any }
export interface PortalSnapshotResult { name: string; tree: string }
export interface PortalNavigateArgs { name: string; url: string }
export interface PortalInfoResult { name: string; url: string; title: string; viewport: { width: number; height: number } }
export interface PortalTextResult { name: string; text: string }
export interface PortalHtmlResult { name: string; html: string }
export interface PortalLogsResult { name: string; entries: Array<{ level: string; text: string; time: number }> }
