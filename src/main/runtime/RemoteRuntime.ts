// =============================================================================
// RemoteRuntime — a Runtime whose every operation is an RPC to a daemon over
// a RuntimeRpcClient. This is the ONLY Runtime implementation: the local
// machine, a server, and WSL all run the same daemon, so the IPC handlers neither
// know nor care which host they are talking to.
// =============================================================================

import { Methods } from '../../runtime/protocol'
import type { RuntimeId } from './locator'
import type {
  Runtime,
  FileHost,
  ProcessHost,
  PtyActivity,
  AgentHost,
  AgentHandle,
  PtyHandle,
  VcsHost,
  GitStatusResult,
  MonitorStatusResult,
  GitPullResult,
  GitLogEntry,
  GitBranchListResult,
  Worktree,
  WorktreeStatusResult,
  MergeResult,
  CreatePrResult,
  PrStatusResult,
  PrSummary,
} from './types'
import type { RuntimeRpcClient } from './rpcClient'
import type { FsWatchEvtPayload, PtyEvtPayload, AgentEvtPayload, SearchEvtPayload } from '../../runtime/protocol'
import type { FileTreeNode, FileSearchResult, FileSearchOptions } from '../../shared/types'

export class RemoteRuntime implements Runtime {
  readonly process: ProcessHost
  readonly agent: AgentHost
  readonly file: FileHost
  readonly vcs: VcsHost
  private ptySeq = 0

  constructor(
    readonly id: RuntimeId,
    private readonly rpc: RuntimeRpcClient,
  ) {
    const call = <T>(method: string, params: unknown[] = []) =>
      this.rpc.call(method, params) as Promise<T>
    // Long ops (tarball install, network git, full-tree search, byte upload)
    // routinely outrun the default 30s timeout on a real remote host. They run
    // with no client-side deadline; the daemon still owns liveness via the
    // transport closing (which rejects all in-flight calls).
    const longCall = <T>(method: string, params: unknown[] = []) =>
      this.rpc.call(method, params, { timeoutMs: 0 }) as Promise<T>

    this.process = {
      create: async (opts, onData, onExit) => {
        // Client-generated id == the stream key. Register BEFORE the create
        // round-trip so the daemon's first output (it arrives after the res on
        // an ordered pipe, but the listener must already exist) is never lost.
        const id = `rpty-${++this.ptySeq}-${this.id}`
        this.rpc.registerStream(id, (payload) => {
          const p = payload as PtyEvtPayload
          if (p.kind === 'data') onData(id, p.data)
          else { onExit(id, p.exitCode); this.rpc.unregisterStream(id) }
        })
        try {
          const handle = await call<PtyHandle>(Methods.ptyCreate, [{ ...opts, id }])
          return { ...handle, id }
        } catch (err) {
          this.rpc.unregisterStream(id)
          throw err
        }
      },
      write: (id, data) => { void this.rpc.call(Methods.ptyWrite, [id, data]).catch(() => {}) },
      resize: (id, cols, rows) => { void this.rpc.call(Methods.ptyResize, [id, cols, rows]).catch(() => {}) },
      kill: (id) => {
        void this.rpc.call(Methods.ptyKill, [id]).catch(() => {})
        this.rpc.unregisterStream(id)
      },
      getCwd: (id) => call<string | null>(Methods.ptyGetCwd, [id]),
      setVisibility: (id, visible) => { void this.rpc.call(Methods.ptySetVisibility, [id, visible]).catch(() => {}) },
      scanActivity: (ids) => call<Record<string, PtyActivity>>(Methods.ptyScanActivity, [ids]),
      scanPorts: (ids) => call<Record<string, number[]>>(Methods.ptyScanPorts, [ids]),
    }

    // Agent: pi runs on the daemon's host; lines/exit stream back keyed by the
    // caller-generated id (PiRpcClient registers before start, like ptyCreate).
    this.agent = {
      ensurePi: () => longCall<void>(Methods.agentEnsurePi, []),
      start: async (opts, onLine, onExit) => {
        this.rpc.registerStream(opts.id, (payload) => {
          const p = payload as AgentEvtPayload
          if (p.kind === 'line') onLine(opts.id, p.line)
          else { onExit(opts.id, p.code, p.stderr); this.rpc.unregisterStream(opts.id) }
        })
        try {
          return await call<AgentHandle>(Methods.agentStart, [opts])
        } catch (err) {
          this.rpc.unregisterStream(opts.id)
          throw err
        }
      },
      writeLine: (id, line) => { void this.rpc.call(Methods.agentWriteLine, [id, line]).catch(() => {}) },
      stop: (id) => {
        void this.rpc.call(Methods.agentStop, [id]).catch(() => {})
        this.rpc.unregisterStream(id)
      },
    }

    this.file = {
      readFile: (p) => call<string>(Methods.fileReadFile, [p]),
      readBinary: async (p) =>
        Buffer.from(await call<string>(Methods.fileReadBinary, [p]), 'base64'),
      writeFile: (p, content) => call<void>(Methods.fileWriteFile, [p, content]),
      writeBinary: (p, data) => longCall<void>(Methods.fileWriteBinary, [p, data.toString('base64')]),
      readDir: (p) => call<FileTreeNode[]>(Methods.fileReadDir, [p]),
      stat: (p) => call<{ isDirectory: boolean; isFile: boolean }>(Methods.fileStat, [p]),
      remove: (p) => call<void>(Methods.fileRemove, [p]),
      rename: (oldP, newP) => call<void>(Methods.fileRename, [oldP, newP]),
      mkdir: (p) => call<void>(Methods.fileMkdir, [p]),
      copy: (src, destDir) => call<string>(Methods.fileCopy, [src, destDir]),
      importEntries: (sources, destDir, mode, winId) =>
        call<{ created: string[]; failed: number }>(Methods.fileImportEntries, [sources, destDir, mode, winId]),
      search: (root, query, opts?: FileSearchOptions) =>
        longCall<FileSearchResult[]>(Methods.fileSearch, [root, query, opts]),
      searchContent: (root, opts, cbs) => {
        // Server-assigned streamId, like watch: start, then register the stream
        // when the round-trip resolves. batch/done arrive as evt frames.
        let streamId: string | null = null
        let stopped = false
        void call<string>(Methods.fileSearchContentStart, [root, opts]).then((id) => {
          if (stopped) {
            // Cancelled before the start round-trip resolved.
            void this.rpc.call(Methods.fileSearchContentStop, [id]).catch(() => {})
            return
          }
          streamId = id
          this.rpc.registerStream(id, (payload) => {
            const p = payload as SearchEvtPayload
            if (p.kind === 'batch') cbs.onBatch(p.files)
            else {
              cbs.onDone(p.stats, p.error)
              this.rpc.unregisterStream(id)
            }
          })
        }).catch((err) => {
          // The start request itself failed (e.g. transport dropped): surface a
          // terminal done so the renderer's spinner clears.
          if (!stopped) cbs.onDone({ matches: 0, files: 0, truncated: false }, err instanceof Error ? err.message : String(err))
        })
        return {
          cancel: () => {
            stopped = true
            if (streamId) {
              this.rpc.unregisterStream(streamId)
              void this.rpc.call(Methods.fileSearchContentStop, [streamId]).catch(() => {})
              streamId = null
            }
          },
        }
      },
      watch: (prefix, onChange) => {
        let streamId: string | null = null
        let stopped = false
        void call<string>(Methods.fileWatchStart, [prefix]).then((id) => {
          if (stopped) {
            // Unsubscribed before the start round-trip resolved.
            void this.rpc.call(Methods.fileWatchStop, [id]).catch(() => {})
            return
          }
          streamId = id
          this.rpc.registerStream(id, (payload) => {
            const p = payload as FsWatchEvtPayload
            onChange(p.changedPath, p.type)
          })
        }).catch(() => { /* watch failed to start; no events */ })
        return () => {
          stopped = true
          if (streamId) {
            this.rpc.unregisterStream(streamId)
            void this.rpc.call(Methods.fileWatchStop, [streamId]).catch(() => {})
            streamId = null
          }
        }
      },
    }

    this.vcs = {
      isRepo: (dir) => call<boolean>(Methods.vcsIsRepo, [dir]),
      init: (dir) => call<void>(Methods.vcsInit, [dir]),
      lsFiles: (dir) => call<string[]>(Methods.vcsLsFiles, [dir]),
      status: (cwd) => call<GitStatusResult>(Methods.vcsStatus, [cwd]),
      diff: (cwd, filePath) => call<string>(Methods.vcsDiff, [cwd, filePath]),
      diffStaged: (cwd, filePath) => call<string>(Methods.vcsDiffStaged, [cwd, filePath]),
      monitorStatus: (cwd) => call<MonitorStatusResult>(Methods.vcsMonitorStatus, [cwd]),
      stage: (cwd, filePath) => call<void>(Methods.vcsStage, [cwd, filePath]),
      unstage: (cwd, filePath) => call<void>(Methods.vcsUnstage, [cwd, filePath]),
      commit: (cwd, message) => call<void>(Methods.vcsCommit, [cwd, message]),
      push: (cwd, remote, branch) => longCall<void>(Methods.vcsPush, [cwd, remote, branch]),
      pull: (cwd, remote, branch) => longCall<GitPullResult>(Methods.vcsPull, [cwd, remote, branch]),
      fetch: (cwd, remote) => longCall<void>(Methods.vcsFetch, [cwd, remote]),
      log: (cwd, maxCount) => call<GitLogEntry[]>(Methods.vcsLog, [cwd, maxCount]),
      branchList: (cwd) => call<GitBranchListResult>(Methods.vcsBranchList, [cwd]),
      branchCreate: (cwd, name, startPoint) => call<void>(Methods.vcsBranchCreate, [cwd, name, startPoint]),
      branchDelete: (cwd, name, force) => call<void>(Methods.vcsBranchDelete, [cwd, name, force]),
      checkout: (cwd, branch) => call<void>(Methods.vcsCheckout, [cwd, branch]),
      stash: (cwd, message) => call<void>(Methods.vcsStash, [cwd, message]),
      stashPop: (cwd) => call<void>(Methods.vcsStashPop, [cwd]),
      discardFile: (cwd, filePath) => call<void>(Methods.vcsDiscardFile, [cwd, filePath]),
      worktreeList: (cwd) => call<Worktree[]>(Methods.vcsWorktreeList, [cwd]),
      worktreeAdd: (repoCwd, branch, target, options) =>
        call<{ path: string; branch: string }>(Methods.vcsWorktreeAdd, [repoCwd, branch, target, options]),
      worktreeAddFromPr: (repoCwd, pr, target, options) =>
        longCall<{ path: string; branch: string }>(Methods.vcsWorktreeAddFromPr, [repoCwd, pr, target, options]),
      worktreeRemove: (repoCwd, worktreePath, options) =>
        call<void>(Methods.vcsWorktreeRemove, [repoCwd, worktreePath, options]),
      worktreePrune: (repoCwd) => call<{ output: string }>(Methods.vcsWorktreePrune, [repoCwd]),
      worktreeStatus: (worktreePath) => call<WorktreeStatusResult | null>(Methods.vcsWorktreeStatus, [worktreePath]),
      worktreeMergeTo: (repoCwd, from, to) => call<MergeResult>(Methods.vcsWorktreeMergeTo, [repoCwd, from, to]),
      worktreeUpdateFrom: (worktreePath, from) => call<MergeResult>(Methods.vcsWorktreeUpdateFrom, [worktreePath, from]),
      createPr: (worktreePath, branch) => longCall<CreatePrResult>(Methods.vcsCreatePr, [worktreePath, branch]),
      prStatus: (worktreePath, branch) => longCall<PrStatusResult | null>(Methods.vcsPrStatus, [worktreePath, branch]),
      prList: (repoCwd) => longCall<PrSummary[]>(Methods.vcsPrList, [repoCwd]),
    }
  }

  // Validation runs authoritatively on the daemon (only it can realpath the
  // remote filesystem). These mirror the Runtime contract; the lexical local
  // fast-fail can be layered on later without changing callers.
  validatePath(filePath: string, ownerWindowId?: number, scopeId?: string): string {
    // Synchronous in the interface, but the authoritative check is remote and
    // async. We return the path as-is here; FileHost methods themselves call
    // through to the daemon, which validates before touching the fs.
    void ownerWindowId
    void scopeId
    return filePath
  }

  async validatePathStrict(filePath: string, ownerWindowId?: number, scopeId?: string): Promise<string> {
    return this.rpc.call(Methods.validatePathStrict, [filePath, ownerWindowId, scopeId]) as Promise<string>
  }

  async validatePathForCreation(filePath: string, ownerWindowId?: number, scopeId?: string): Promise<string> {
    return this.rpc.call(Methods.validatePathForCreation, [filePath, ownerWindowId, scopeId]) as Promise<string>
  }

  validateCwd(cwd: string, ownerWindowId?: number, scopeId?: string): string {
    // Authoritative validation happens on the daemon inside each vcs op.
    void ownerWindowId
    void scopeId
    return cwd
  }

  addAllowedRoot(root: string, scopeId?: string): Promise<void> {
    return this.rpc.call(Methods.addAllowedRoot, [root, scopeId]) as Promise<void>
  }

  removeAllowedRoot(root: string, scopeId?: string): Promise<void> {
    return this.rpc.call(Methods.removeAllowedRoot, [root, scopeId]) as Promise<void>
  }

  setExclusions(names: string[]): Promise<void> {
    return this.rpc.call(Methods.setExclusions, [names]) as Promise<void>
  }

  setIdleSuspend(enabled: boolean): Promise<void> {
    return this.rpc.call(Methods.setIdleSuspend, [enabled]) as Promise<void>
  }

  grantFileAccess(filePath: string, ownerWindowId: number): Promise<void> {
    return this.rpc.call(Methods.grantFileAccess, [filePath, ownerWindowId]) as Promise<void>
  }

  registerScopedWriteAllowance(safePath: string, ownerWindowId: number): Promise<void> {
    return this.rpc.call(Methods.registerScopedWriteAllowance, [safePath, ownerWindowId]) as Promise<void>
  }

  clearFileGrantsForWindow(windowId: number): Promise<void> {
    return this.rpc.call(Methods.clearFileGrantsForWindow, [windowId]) as Promise<void>
  }

  clearScopedWriteAllowancesForWindow(windowId: number): Promise<void> {
    return this.rpc.call(Methods.clearScopedWriteAllowancesForWindow, [windowId]) as Promise<void>
  }
}
