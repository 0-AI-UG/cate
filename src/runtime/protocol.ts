// =============================================================================
// Runtime wire protocol — LF-delimited JSON frames over a duplex stdio pipe.
// The same protocol is spoken whether the daemon runs locally (child process),
// on a server (over SSH exec), or in WSL (over wsl.exe). Generalized from the
// pi RpcClient pattern; client correlates responses by id, the daemon pushes
// unsolicited `evt` frames for streams (PTY data, fs-watch events).
//
// This module is part of the standalone runtime bundle, so it must stay
// dependency-free apart from pure @shared types.
// =============================================================================

import type { SearchFileResult, SearchStats } from '../shared/types'

/** Bumped only on a wire-incompatible change. A mismatch is a hard failure. */
export const RUNTIME_PROTOCOL_VERSION = 1

// ---- Handshake -------------------------------------------------------------

/** First frame the daemon emits on startup, before any response. */
export interface HelloFrame {
  t: 'hello'
  runtimeVersion: string
  protocolVersion: number
  node: { version: string; modules: number }
  os: { platform: string; arch: string; libc: 'glibc' | 'musl' | 'unknown' }
}

// ---- Request / response ----------------------------------------------------

export interface ReqFrame {
  t: 'req'
  id: number
  method: string
  params: unknown[]
}

export type ResFrame =
  | { t: 'res'; id: number; ok: true; data: unknown }
  | { t: 'res'; id: number; ok: false; error: string }

// ---- Streaming -------------------------------------------------------------

/** Unsolicited daemon→client frame, routed by streamId to a listener the
 *  client registered when the stream-producing request resolved. */
export interface EvtFrame {
  t: 'evt'
  streamId: string
  payload: unknown
}

export type ClientFrame = ReqFrame
export type ServerFrame = HelloFrame | ResFrame | EvtFrame
export type AnyFrame = ClientFrame | ServerFrame

// ---- Methods ---------------------------------------------------------------
//
// Dotted method names map 1:1 to Runtime capability methods. The daemon's
// rpcServer holds the dispatch table; RemoteRuntime issues these from the
// client side. `readBinary` is the one method whose result is base64 on the
// wire (a Buffer doesn't survive JSON) — encoded by the server, decoded by the
// client.

export const Methods = {
  ping: 'ping',

  validatePath: 'validatePath',
  validatePathStrict: 'validatePathStrict',
  validatePathForCreation: 'validatePathForCreation',
  validateCwd: 'validateCwd',
  addAllowedRoot: 'addAllowedRoot',
  removeAllowedRoot: 'removeAllowedRoot',
  setExclusions: 'setExclusions',
  setIdleSuspend: 'setIdleSuspend',
  grantFileAccess: 'grantFileAccess',
  registerScopedWriteAllowance: 'registerScopedWriteAllowance',
  clearFileGrantsForWindow: 'clearFileGrantsForWindow',
  clearScopedWriteAllowancesForWindow: 'clearScopedWriteAllowancesForWindow',

  fileReadFile: 'file.readFile',
  fileReadBinary: 'file.readBinary', // result is base64
  fileWriteFile: 'file.writeFile',
  fileWriteBinary: 'file.writeBinary', // data is base64 on the wire
  fileReadDir: 'file.readDir',
  fileStat: 'file.stat',
  fileRemove: 'file.remove',
  fileRename: 'file.rename',
  fileMkdir: 'file.mkdir',
  fileCopy: 'file.copy',
  fileImportEntries: 'file.importEntries',
  fileSearch: 'file.search',
  fileSearchContentStart: 'file.searchContent.start', // returns a streamId; batch/done arrive as evt frames
  fileSearchContentStop: 'file.searchContent.stop',
  fileWatchStart: 'file.watch.start', // returns a streamId; events arrive as evt frames
  fileWatchStop: 'file.watch.stop',

  ptyCreate: 'pty.create', // params [opts incl. id]; data/exit arrive as evt frames keyed by id
  ptyWrite: 'pty.write',
  ptyResize: 'pty.resize',
  ptyKill: 'pty.kill',
  ptyGetCwd: 'pty.getCwd',
  ptySetVisibility: 'pty.setVisibility',
  ptyScanActivity: 'pty.scanActivity',
  ptyScanPorts: 'pty.scanPorts',

  vcsIsRepo: 'vcs.isRepo',
  vcsFindRepos: 'vcs.findRepos',
  vcsInit: 'vcs.init',
  vcsLsFiles: 'vcs.lsFiles',
  vcsStatus: 'vcs.status',
  vcsDiff: 'vcs.diff',
  vcsDiffStaged: 'vcs.diffStaged',
  vcsMonitorStatus: 'vcs.monitorStatus',
  vcsStage: 'vcs.stage',
  vcsUnstage: 'vcs.unstage',
  vcsCommit: 'vcs.commit',
  vcsPush: 'vcs.push',
  vcsPull: 'vcs.pull',
  vcsFetch: 'vcs.fetch',
  vcsLog: 'vcs.log',
  vcsBranchList: 'vcs.branchList',
  vcsBranchCreate: 'vcs.branchCreate',
  vcsBranchDelete: 'vcs.branchDelete',
  vcsCheckout: 'vcs.checkout',
  vcsStash: 'vcs.stash',
  vcsStashPop: 'vcs.stashPop',
  vcsDiscardFile: 'vcs.discardFile',
  vcsWorktreeList: 'vcs.worktreeList',
  vcsWorktreeAdd: 'vcs.worktreeAdd',
  vcsWorktreeAddFromPr: 'vcs.worktreeAddFromPr',
  vcsWorktreeRemove: 'vcs.worktreeRemove',
  vcsWorktreePrune: 'vcs.worktreePrune',
  vcsWorktreeStatus: 'vcs.worktreeStatus',
  vcsWorktreeMergeTo: 'vcs.worktreeMergeTo',
  vcsWorktreeUpdateFrom: 'vcs.worktreeUpdateFrom',
  vcsCreatePr: 'vcs.createPr',
  vcsPrStatus: 'vcs.prStatus',
  vcsPrList: 'vcs.prList',

  // --- agent (pi coding agent) --- pi's stdout lines / exit stream back as evt
  // frames keyed by the agent id; the daemon is a dumb pipe (never parses pi's
  // protocol). ensurePi installs the pi tarball on the host before the first start.
  agentEnsurePi: 'agent.ensurePi',
  agentStart: 'agent.start', // params [opts incl. id]; lines/exit arrive as evt frames keyed by id
  agentWriteLine: 'agent.writeLine',
  agentStop: 'agent.stop',
} as const

export type MethodName = (typeof Methods)[keyof typeof Methods]

/** Mirrors FsChangeType in main/runtime/types. Inlined here so protocol.ts
 *  stays dependency-light (it type-imports nothing from the main process). */
export type FsChangeType = 'create' | 'update' | 'delete'

/** Payload carried by a `file.watch` stream's evt frames. */
export interface FsWatchEvtPayload {
  changedPath: string
  type: FsChangeType
}

/** Payload carried by an `agent.start` stream's evt frames (keyed by agent id).
 *  `line` is one raw JSONL line of pi's stdout; the client parses pi's protocol. */
export type AgentEvtPayload =
  | { kind: 'line'; line: string }
  | { kind: 'exit'; code: number; stderr?: string }

/** Payload carried by a `pty.create` stream's evt frames (keyed by the pty id). */
export type PtyEvtPayload =
  | { kind: 'data'; data: string }
  | { kind: 'exit'; exitCode: number }

/** Payload carried by a `file.searchContent` stream's evt frames. `batch`
 *  delivers completed-file results as they arrive; `done` fires once with final
 *  stats (and an error string when the search failed). */
export type SearchEvtPayload =
  | { kind: 'batch'; files: SearchFileResult[] }
  | { kind: 'done'; stats: SearchStats; error?: string }
