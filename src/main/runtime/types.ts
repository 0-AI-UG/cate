// =============================================================================
// Runtime capability interfaces — the contract every backend implements. Every
// host (local machine, server, WSL) runs the standalone runtime daemon and is
// reached as a RemoteRuntime over stdio JSON-RPC; there is no in-process
// implementation.
//
// These interfaces are the seam the IPC handlers in terminal.ts / filesystem.ts
// / git.ts delegate to. They are intentionally shaped so the SAME capability
// implementation can run inside the standalone runtime bundle:
//   - methods are async and take/return JSON-serializable values
//   - streaming (PTY output, fs-watch events) is delivered via callbacks, so
//     the IPC layer keeps ownership of WHERE a stream is forwarded (e.g. which
//     window a terminal currently belongs to — see terminalOwners in
//     terminal.ts, which must stay in the IPC layer for cross-window transfer).
// =============================================================================

import type { FileTreeNode, FileSearchResult, FileSearchOptions, SearchOptions, SearchFileResult, SearchStats, TerminalActivity } from '../../shared/types'
import type { RuntimeId } from './locator'

// ---------------------------------------------------------------------------
// Process host (terminals / node-pty)
// ---------------------------------------------------------------------------

export interface PtyCreateOptions {
  cols: number
  rows: number
  /** Runtime-absolute, already validated working directory. */
  cwd: string
  /** Requested shell; the host resolves + falls back as today (resolveShell). */
  shell?: string
  /** Caller-provided id. Used over the wire so the client registers its data
   *  stream before the create round-trip resolves (no early-output race). */
  id?: string
}

export interface PtyHandle {
  id: string
  pid: number
  /** Optional notice to surface in the terminal (e.g. shell fallback warning). */
  notice?: string
  /** The shell path the host actually spawned (after the host's own resolution).
   *  Carried back purely for diagnostics — e.g. logging which shell a terminal
   *  that exited immediately was running (#401). */
  shell?: string
}

/** Per-pty process-tree-derived activity, for the shell process monitor.
 *  `activity` mirrors what shell.ts broadcasts on SHELL_ACTIVITY_UPDATE; the
 *  agent fields say whether a known agent CLI (Claude/Codex/pi/…) is a direct
 *  child and its display name. Carry-across of a transient miss + the screen-
 *  state override stay in shell.ts (session-layer concerns). */
export interface PtyActivity {
  activity: TerminalActivity
  agentName: string | null
  agentPresent: boolean
}

export interface ProcessHost {
  /**
   * Spawn a PTY. `onData` fires for every chunk of output; `onExit` fires once
   * with the exit code. Both are window-agnostic — the IPC layer decides which
   * window to forward to (so a terminal can be transferred between windows).
   */
  create(
    opts: PtyCreateOptions,
    onData: (id: string, data: string) => void,
    onExit: (id: string, exitCode: number) => void,
  ): Promise<PtyHandle>
  write(id: string, data: string): void
  resize(id: string, cols: number, rows: number): void
  kill(id: string): void
  getCwd(id: string): Promise<string | null>
  setVisibility(id: string, visible: boolean): void
  /**
   * Process-monitor scan for the given pty ids (those this host owns). Takes ONE
   * `ps` snapshot of the host's process table and derives, per id, the activity
   * indicator + agent-CLI detection. Runs on whichever host owns the ptys, so a
   * remote terminal's activity reflects the daemon's process tree. Ids not owned
   * by this host are omitted. POSIX-only; returns {} where `ps` is unavailable.
   */
  scanActivity(ids: string[]): Promise<Record<string, PtyActivity>>
  /**
   * Listening-TCP-port scan for the given pty ids. One `ps` snapshot (to map each
   * pty's process subtree) + one `lsof` scoped to those pids. Returns the ports
   * each pty's tree is listening on (dev-server chips). Ids with no listeners are
   * omitted. POSIX-only; returns {} where `lsof` is unavailable.
   */
  scanPorts(ids: string[]): Promise<Record<string, number[]>>
}

// ---------------------------------------------------------------------------
// Agent host (the pi coding agent, run in `--mode rpc`)
//
// A duplex line channel per session. The host (local or daemon) spawns pi where
// the files are, after ensuring the pi tarball is installed on that host. It is
// a DUMB PIPE: it forwards pi's stdout lines verbatim and writes lines to pi's
// stdin — it never parses pi's JSONL protocol (that lives in PiRpcClient). This
// is what lets the agent run identically local and remote, with pi shipped on
// demand rather than bundled in the app.
// ---------------------------------------------------------------------------

export interface AgentStartOptions {
  /** Caller-generated id; also the evt stream key (register before start). */
  id: string
  /** Runtime-absolute working directory (the daemon validates it). */
  cwd: string
  /** PI_CODING_AGENT_DIR + any extra env for pi. */
  env?: Record<string, string>
  provider?: string
  model?: string
  /** Extra pi CLI args (e.g. --session <file>). */
  args?: string[]
}

export interface AgentHandle {
  id: string
  pid: number
}

export interface AgentHost {
  /** Ensure the pi runtime is installed on this host (pull/extract the tarball).
   *  Safe to call repeatedly; resolves once pi is ready to spawn. */
  ensurePi(): Promise<void>
  /**
   * Spawn pi in `--mode rpc`. `onLine` fires for each raw JSONL line pi writes;
   * `onExit` fires once. Both window-agnostic — the agent layer routes them.
   */
  start(
    opts: AgentStartOptions,
    onLine: (id: string, line: string) => void,
    /** `stderr` carries pi's recent stderr (its crash reason on an early exit). */
    onExit: (id: string, code: number, stderr?: string) => void,
  ): Promise<AgentHandle>
  writeLine(id: string, line: string): void
  stop(id: string): void
}

// ---------------------------------------------------------------------------
// File host (fs/promises + chokidar)
// ---------------------------------------------------------------------------

export type FsChangeType = 'create' | 'update' | 'delete'

export interface FsChangeEvent {
  type: FsChangeType
  /** Runtime-absolute path of the changed entry. */
  path: string
}

// NOTE (Phase 1, filesystem = "Model A"): every `path`/`dir` argument below is
// an ALREADY-VALIDATED, runtime-absolute path. The IPC handler validates the
// raw locator path via `Runtime.validate*` first, then passes the safe path
// here. This keeps these leaf ops pure fs — directly reusable by the standalone
// runtime daemon in Phase 3. `importEntries` is the lone exception: it computes
// per-item destinations, so it validates each one internally (hence ownerWindowId).
export interface FileHost {
  readFile(safePath: string): Promise<string>
  readBinary(safePath: string): Promise<Buffer>
  writeFile(safePath: string, content: string): Promise<void>
  /** Write raw bytes. Used by remote upload (drag-import into a remote workspace):
   *  the source is read on the client and its bytes written here on the host. */
  writeBinary(safePath: string, data: Buffer): Promise<void>
  readDir(safePath: string): Promise<FileTreeNode[]>
  stat(safePath: string): Promise<{ isDirectory: boolean; isFile: boolean }>
  remove(safePath: string): Promise<void>
  rename(safeOldPath: string, safeNewPath: string): Promise<void>
  mkdir(safePath: string): Promise<void>
  /** Copy into a directory, auto-naming on collision; returns the final path. */
  copy(safeSrcPath: string, safeDestDir: string): Promise<string>
  importEntries(
    sources: string[],
    safeDestDir: string,
    mode: 'copy' | 'move',
    ownerWindowId?: number,
  ): Promise<{ created: string[]; failed: number }>
  search(safeRoot: string, query: string, opts?: FileSearchOptions): Promise<FileSearchResult[]>
  /**
   * Streaming ripgrep content search (the VS Code-style Search view). Runs on
   * whichever host owns the files — the local machine spawns its bundled
   * ripgrep, a remote daemon spawns the ripgrep shipped in its tarball — so a
   * remote workspace is searched on the remote, not the client. `onBatch` fires
   * per completed-file batch with host-absolute paths (the IPC layer re-encodes
   * them as runtime locators); `onDone` fires exactly once. The returned
   * `cancel()` kills the search. Mirrors `watch`'s synchronous-handle shape.
   */
  searchContent(
    safeRoot: string,
    opts: SearchOptions,
    callbacks: {
      onBatch: (files: SearchFileResult[]) => void
      onDone: (stats: SearchStats, error?: string) => void
    },
  ): { cancel: () => void }
  /**
   * Subscribe to filesystem changes under `prefix`. Returns an unsubscribe fn.
   * Matches the in-process `subscribeFsChanges` semantics (one call per event,
   * no coalescing — the caller debounces). `type` carries the real change kind
   * (create/update/delete) so consumers can prune removed entries; the git
   * monitor ignores it. Used by the git monitor and the remote watch wrapper.
   * The renderer-facing watch path (per-window debounce + FS_WATCH_EVENT) stays
   * its own window-keyed wrapper in filesystem.ts for now (routed in Phase 3).
   */
  watch(prefix: string, onChange: (changedPath: string, type: FsChangeType) => void): () => void
}

// ---------------------------------------------------------------------------
// Vcs host (simple-git + gh). Return shapes mirror the objects the existing
// git.ts handlers already send to the renderer, so renderer types are unchanged.
// ---------------------------------------------------------------------------

export interface GitStatusResult {
  files: Array<{ path: string; index: string; working_dir: string }>
  current: string | null
  tracking: string | null
  ahead: number
  behind: number
}

export interface GitPullResult {
  summary: { changes: number; insertions: number; deletions: number }
}

export interface GitLogEntry {
  hash: string
  message: string
  author_name: string
  author_email: string
  date: string
}

export interface GitBranchListResult {
  current: string
  branches: Array<{
    name: string
    current: boolean
    commit: string
    label: string
    isRemote: boolean
  }>
}

export interface Worktree {
  path: string
  branch: string
  isBare: boolean
  isCurrent: boolean
}

export interface WorktreeStatusResult {
  branch: string
  dirty: boolean
  ahead: number
  behind: number
  staged: number
  unstaged: number
  untracked: number
}

/** Lightweight poll result for the sidebar git monitor (git-monitor.ts). Mirrors
 *  exactly what the monitor needs: the current branch + dirty flag it broadcasts
 *  (GIT_BRANCH_UPDATE), plus the local branch name list it diffs to detect a
 *  non-current-branch deletion and re-notify the UI. */
export interface MonitorStatusResult {
  branch: string | null
  dirty: boolean
  /** Local branch short names (refs/heads), unordered. */
  branches: string[]
}

export type MergeResult =
  | { ok: true; result: unknown }
  | { ok: false; conflict: boolean; message: string }

export type CreatePrResult =
  | { ok: true; created: boolean; url: string; fallback?: boolean }
  | { ok: false; message: string }

export interface PrStatusResult {
  number: number
  state: string
  url: string
  isDraft: boolean
}

export interface PrSummary {
  number: number
  title: string
  headRefName: string
  author: string
  isFork: boolean
}

// NOTE (Phase 1, git = "Model B"): unlike FileHost, these methods take the RAW
// runtime-path `cwd` and validate it internally (via validateCwd), mirroring
// the existing handler bodies and the already-exported `createBranch`. The
// daemon supplies its own validateCwd in Phase 3, so the functions stay
// relocatable.
export interface VcsHost {
  isRepo(dir: string): Promise<boolean>
  init(dir: string): Promise<void>
  lsFiles(dir: string): Promise<string[]>
  status(cwd: string): Promise<GitStatusResult>
  diff(cwd: string, filePath?: string): Promise<string>
  diffStaged(cwd: string, filePath?: string): Promise<string>
  /** Cheap poll for the sidebar branch/dirty indicator. */
  monitorStatus(cwd: string): Promise<MonitorStatusResult>
  stage(cwd: string, filePath: string): Promise<void>
  unstage(cwd: string, filePath: string): Promise<void>
  commit(cwd: string, message: string): Promise<void>
  push(cwd: string, remote?: string, branch?: string): Promise<void>
  pull(cwd: string, remote?: string, branch?: string): Promise<GitPullResult>
  fetch(cwd: string, remote?: string): Promise<void>
  log(cwd: string, maxCount?: number): Promise<GitLogEntry[]>
  branchList(cwd: string): Promise<GitBranchListResult>
  branchCreate(cwd: string, name: string, startPoint?: string): Promise<void>
  branchDelete(cwd: string, name: string, force?: boolean): Promise<void>
  checkout(cwd: string, branch: string): Promise<void>
  stash(cwd: string, message?: string): Promise<void>
  stashPop(cwd: string): Promise<void>
  discardFile(cwd: string, filePath: string): Promise<void>
  worktreeList(cwd: string): Promise<Worktree[]>
  worktreeAdd(
    repoCwd: string,
    branch: string,
    targetPath: string,
    options?: { createBranch?: boolean; baseRef?: string; symlinkPaths?: string[] },
  ): Promise<{ path: string; branch: string }>
  worktreeAddFromPr(
    repoCwd: string,
    prNumber: number,
    targetPath: string,
    options?: { symlinkPaths?: string[] },
  ): Promise<{ path: string; branch: string }>
  worktreeRemove(repoCwd: string, worktreePath: string, options?: { force?: boolean }): Promise<void>
  worktreePrune(repoCwd: string): Promise<{ output: string }>
  worktreeStatus(worktreePath: string): Promise<WorktreeStatusResult | null>
  worktreeMergeTo(repoCwd: string, fromBranch: string, toBranch: string): Promise<MergeResult>
  worktreeUpdateFrom(worktreePath: string, fromBranch: string): Promise<MergeResult>
  createPr(worktreePath: string, branch: string): Promise<CreatePrResult>
  prStatus(worktreePath: string, branch: string): Promise<PrStatusResult | null>
  prList(repoCwd: string): Promise<PrSummary[]>
}

// ---------------------------------------------------------------------------
// Runtime — the resolved backend for one location. Path validation is a
// method (not a free function) so each runtime enforces its own root set: a
// RemoteRuntime validates against its daemon's roots, authoritatively on the
// daemon side.
// ---------------------------------------------------------------------------

export interface Runtime {
  readonly id: RuntimeId
  readonly process: ProcessHost
  readonly agent: AgentHost
  readonly file: FileHost
  readonly vcs: VcsHost
  /** Lexical + allowed-root check; returns the normalized path. The optional
   *  scopeId restricts the check to one workspace's roots (per-workspace
   *  isolation); when omitted, validation falls back to the union of all roots. */
  validatePath(filePath: string, ownerWindowId?: number, scopeId?: string): string
  /** Strict (symlink-resolving) read validation; returns the real path. */
  validatePathStrict(filePath: string, ownerWindowId?: number, scopeId?: string): Promise<string>
  /** Validate a target whose parent must exist; returns the safe path. */
  validatePathForCreation(filePath: string, ownerWindowId?: number, scopeId?: string): Promise<string>
  /** Directory validation for cwd parameters. */
  validateCwd(cwd: string, ownerWindowId?: number, scopeId?: string): string
  /** Add/remove a path from this runtime's allowed-roots set. For the local
   *  daemon (and remote daemons), workspace roots are forwarded here so the
   *  daemon's authoritative path checks allow them. The optional scopeId keys the
   *  root under one workspace's scope (per-workspace isolation). */
  addAllowedRoot(root: string, scopeId?: string): Promise<void>
  removeAllowedRoot(root: string, scopeId?: string): Promise<void>
  /** Replace this runtime's readDir/search exclusion basenames live (the
   *  daemon's mirror of the fileExclusions setting). For the LOCAL daemon the
   *  main process forwards this when the setting changes, so the file tree /
   *  file-name search hide the new set without an app restart. */
  setExclusions(names: string[]): Promise<void>
  /** Toggle POSIX idle-suspend of backgrounded terminals live (the daemon's
   *  mirror of autoSuspendIdleTerminals). Forwarded to the LOCAL daemon when the
   *  setting changes, so toggling takes effect without an app restart. */
  setIdleSuspend(enabled: boolean): Promise<void>
  /** Forward a persistent per-window file grant (Save-As / open dialogs /
   *  restored grants) to this runtime, so its authoritative path checks allow
   *  the granted out-of-root file. Mirrors pathValidation.grantFileAccess. */
  grantFileAccess(filePath: string, ownerWindowId: number): Promise<void>
  /** Forward a one-shot scoped write allowance to this runtime. Mirrors
   *  pathValidation.registerScopedWriteAllowance. */
  registerScopedWriteAllowance(safePath: string, ownerWindowId: number): Promise<void>
  /** Drop all persistent per-window file grants for a closing window, so the
   *  daemon doesn't accumulate stale grants. Mirrors
   *  pathValidation.clearFileGrantsForWindow. */
  clearFileGrantsForWindow(windowId: number): Promise<void>
  /** Drop all one-shot scoped write allowances for a closing window. Mirrors
   *  pathValidation.clearScopedWriteAllowancesForWindow. */
  clearScopedWriteAllowancesForWindow(windowId: number): Promise<void>
}
