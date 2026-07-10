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
  /** Extra env merged OVER the host's resolved shell env at spawn (e.g. the
   *  first-party CATE_API/CATE_TOKEN vars). Rides the existing opts pass-through
   *  (RemoteRuntime spreads opts; rpcServer forwards verbatim), so no protocol
   *  change is needed to reach a remote host. */
  env?: Record<string, string>
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
// Server host (long-lived HTTP server children for server-backed extensions)
//
// Spawns an extension's server process on whichever host owns the files (local
// or daemon), allocates a loopback port for it, injects that port via env, and
// resolves only once the server answers an HTTP ready probe. stdout/stderr +
// exit stream back via callbacks keyed by the caller-generated id. The tunnel
// host then proxies raw TCP bytes to the bound loopback port.
// ---------------------------------------------------------------------------

export interface ServerStartOptions {
  id: string                      // caller-generated; stdout/stderr+exit evt stream key
  command: string[]               // argv, e.g. ['node','dist/server.js']
  cwd: string                     // runtime-absolute (daemon validates)
  env: Record<string, string>
  portEnv: string                 // daemon injects the allocated port as env[portEnv]
  readyPath: string               // HTTP path polled until ready
  readyTimeoutMs: number
}

export interface ServerHandle { id: string; pid: number; port: number } // port bound 127.0.0.1 on the daemon host

export interface ServerHost {
  start(
    opts: ServerStartOptions,
    onOutput: (id: string, stream: 'stdout' | 'stderr', chunk: string) => void,
    onExit: (id: string, code: number | null, signal: string | null) => void,
  ): Promise<ServerHandle>   // resolves only AFTER the ready probe passes
  stop(id: string): void     // SIGTERM then SIGKILL
}

// ---------------------------------------------------------------------------
// Tunnel host (raw TCP bridge to a server child's loopback port)
//
// Opens a TCP connection on the daemon host to 127.0.0.1:port and bridges its
// bytes (base64) over the runtime pipe, so a server-backed extension's traffic
// can reach a daemon-bound server from the client. Mirrors agent.start's
// register-the-stream-before-start pattern.
// ---------------------------------------------------------------------------

export interface TunnelHost {
  // Open a TCP connection on the daemon host to 127.0.0.1:port. connId is the evt
  // stream key (register before open). Mirrors agent.start register-before-start.
  open(connId: string, port: number, onData: (connId: string, chunkB64: string) => void, onClose: (connId: string) => void): Promise<void>
  write(connId: string, chunkB64: string): void   // outbound bytes, base64
  // Flow-control ack: the client delivered `byteCount` decoded inbound bytes to
  // their destination, so the daemon can resume a socket it paused once its
  // outstanding (sent-but-unacked) credit window drains. Fire-and-forget.
  ack(connId: string, byteCount: number): void
  close(connId: string): void
  // Reverse tunnel (CATE_API): bind a 127.0.0.1 listener on the daemon host and
  // bridge each inbound connection BACK over the pipe. `onConnection(connId)`
  // fires per accepted socket; its bytes then arrive via onData/onClose keyed by
  // that connId, and outbound bytes reuse write/close. Returns the bound port.
  listen(
    listenerId: string,
    onConnection: (connId: string) => void,
    onData: (connId: string, chunkB64: string) => void,
    onClose: (connId: string) => void,
  ): Promise<{ port: number }>
  stopListen(listenerId: string): void
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
// Every operation validates and executes on the owning host in one call. The
// optional access context carries window grants and workspace scope across RPC.
export interface FileAccessContext {
  ownerWindowId?: number
  scopeId?: string
}

export interface FileHost {
  readFile(safePath: string, access?: FileAccessContext): Promise<string>
  readBinary(safePath: string, access?: FileAccessContext): Promise<Buffer>
  /** Returns the canonical path written, used to consume mirrored one-shot grants. */
  writeFile(safePath: string, content: string, access?: FileAccessContext): Promise<string>
  /** Write raw bytes. Used by remote upload (drag-import into a remote workspace):
   *  the source is read on the client and its bytes written here on the host. */
  writeBinary(safePath: string, data: Buffer, access?: FileAccessContext): Promise<string>
  readDir(safePath: string, access?: FileAccessContext): Promise<FileTreeNode[]>
  stat(safePath: string, access?: FileAccessContext): Promise<{ isDirectory: boolean; isFile: boolean }>
  remove(safePath: string, access?: FileAccessContext): Promise<void>
  /** Returns the canonical destination path. */
  rename(safeOldPath: string, safeNewPath: string, access?: FileAccessContext): Promise<string>
  mkdir(safePath: string, access?: FileAccessContext): Promise<void>
  /** Copy into a directory, auto-naming on collision; returns the final path. */
  copy(safeSrcPath: string, safeDestDir: string, access?: FileAccessContext): Promise<string>
  /** The host's per-host extensions install root (~/.cate/extensions), resolved
   *  daemon-side (only the daemon knows its home dir) and registered as an
   *  allowed root. Lets the install flow place an extension on whichever host
   *  owns the workspace — local or remote — with no client-side path guessing. */
  extensionsRoot(): Promise<string>
  /** Validate + untar a host-resident, client-verified .tgz (written via
   *  writeBinary) into `safeDestDir`, atomically; returns `safeDestDir`. The
   *  daemon rejects unsafe (zip-slip / symlink) members and removes the .tgz. */
  extractArtifact(safeTgzPath: string, safeDestDir: string): Promise<string>
  importEntries(
    sources: string[],
    safeDestDir: string,
    mode: 'copy' | 'move',
    access?: FileAccessContext,
  ): Promise<{ created: string[]; failed: number }>
  search(safeRoot: string, query: string, opts?: FileSearchOptions, access?: FileAccessContext): Promise<FileSearchResult[]>
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
    access?: FileAccessContext,
  ): { cancel: () => void }
  /**
   * Subscribe to filesystem changes under `prefix`. Returns an unsubscribe fn.
   * Emits one call per event with no coalescing; the caller debounces. `type`
   * carries the real change kind
   * (create/update/delete) so consumers can prune removed entries; the git
   * monitor ignores it. Used by the git monitor and renderer watch wrapper.
   */
  watch(prefix: string, onChange: (changedPath: string, type: FsChangeType) => void, access?: FileAccessContext): () => void
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
  /** Discover git repos at or below `dir`, scanning at most `maxDepth` levels
   *  (default 1) and stopping at each repo it finds. Returns absolute paths. */
  findRepos(dir: string, maxDepth?: number): Promise<string[]>
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
  readonly server: ServerHost
  readonly tunnel: TunnelHost
  /** Lexical + allowed-root check; returns the normalized path. When scopeId is
   *  omitted, the runtime uses its own configured root scope. */
  validatePath(filePath: string, ownerWindowId?: number, scopeId?: string): string
  /** Strict (symlink-resolving) read validation; returns the real path. */
  validatePathStrict(filePath: string, ownerWindowId?: number, scopeId?: string): Promise<string>
  /** Validate a target whose parent must exist; returns the safe path. */
  validatePathForCreation(filePath: string, ownerWindowId?: number, scopeId?: string): Promise<string>
  /** Directory validation for cwd parameters. */
  validateCwd(cwd: string, ownerWindowId?: number, scopeId?: string): string
  /** Add/remove a path from this runtime's allowed-roots set. For the local
   *  daemon (and remote daemons), workspace roots are forwarded here so the
   *  daemon's authoritative path checks allow them. When scopeId is omitted,
   *  the runtime uses its own configured root scope. */
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
