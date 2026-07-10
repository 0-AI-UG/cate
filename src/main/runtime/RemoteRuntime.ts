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
  ServerHost,
  ServerHandle,
  TunnelHost,
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
import type { FileAccessContext } from './types'
import type { RuntimeRpcClient } from './rpcClient'
import type { FsWatchEvtPayload, PtyEvtPayload, AgentEvtPayload, SearchEvtPayload, ServerEvtPayload, TunnelEvtPayload, TunnelListenEvtPayload } from '../../runtime/protocol'
import type { FileTreeNode, FileSearchResult } from '../../shared/types'

export class RemoteRuntime implements Runtime {
  readonly process: ProcessHost
  readonly agent: AgentHost
  readonly file: FileHost
  readonly vcs: VcsHost
  readonly server: ServerHost
  readonly tunnel: TunnelHost
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

    // The daemon validates every file/vcs path against the scope named in the
    // access context and no longer falls back to its own root scope. Calls that
    // arrive here with NO context at all are main-process-internal (the IPC
    // handlers always attach one, so renderer-driven ops can't take this path):
    // those trusted callers operate at the runtime's own scope, stated
    // explicitly here instead of implicitly at the daemon. A context that IS
    // present but names no scopeId is forwarded as-is and rejected daemon-side
    // (that's the renderer-omitted-workspaceId hole this closes).
    const scoped = (access?: FileAccessContext): FileAccessContext =>
      access ?? { scopeId: this.id }

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

    // Server: the extension's server child runs on the daemon's host; its
    // stdout/stderr + exit stream back keyed by the caller-generated id (register
    // before start, like ptyCreate). start uses longCall — the ready probe can
    // take seconds (well past the default 30s deadline on a cold server).
    this.server = {
      start: async (opts, onOutput, onExit) => {
        this.rpc.registerStream(opts.id, (payload) => {
          const p = payload as ServerEvtPayload
          if (p.kind === 'output') onOutput(opts.id, p.stream, p.chunk)
          else { onExit(opts.id, p.code, p.signal); this.rpc.unregisterStream(opts.id) }
        })
        try {
          return await longCall<ServerHandle>(Methods.serverStart, [opts])
        } catch (err) {
          this.rpc.unregisterStream(opts.id)
          throw err
        }
      },
      stop: (id) => {
        void this.rpc.call(Methods.serverStop, [id]).catch(() => {})
        this.rpc.unregisterStream(id)
      },
    }

    // Tunnel: raw TCP bridge to a server child's loopback port on the daemon.
    // data/close stream back keyed by the caller-generated connId (register
    // before open, like agent.start).
    this.tunnel = {
      open: async (connId, port, onData, onClose) => {
        this.rpc.registerStream(connId, (payload) => {
          const p = payload as TunnelEvtPayload
          if (p.kind === 'data') onData(connId, p.chunk)
          else { onClose(connId); this.rpc.unregisterStream(connId) }
        })
        try {
          await call<void>(Methods.tunnelOpen, [connId, port])
        } catch (err) {
          this.rpc.unregisterStream(connId)
          throw err
        }
      },
      write: (connId, chunkB64) => { void this.rpc.call(Methods.tunnelWrite, [connId, chunkB64]).catch(() => {}) },
      ack: (connId, byteCount) => { void this.rpc.call(Methods.tunnelAck, [connId, byteCount]).catch(() => {}) },
      close: (connId) => {
        void this.rpc.call(Methods.tunnelClose, [connId]).catch(() => {})
        this.rpc.unregisterStream(connId)
      },
      // Reverse tunnel: register the listenerId stream BEFORE listen so a
      // `connection` evt (arriving after the res on the ordered pipe) is never
      // lost. Each connection registers its own connId substream for data/close.
      listen: async (listenerId, onConnection, onData, onClose) => {
        this.rpc.registerStream(listenerId, (payload) => {
          const p = payload as TunnelListenEvtPayload
          if (p.kind === 'connection') {
            const connId = p.connId
            this.rpc.registerStream(connId, (cp) => {
              const d = cp as TunnelEvtPayload
              if (d.kind === 'data') onData(connId, d.chunk)
              else { onClose(connId); this.rpc.unregisterStream(connId) }
            })
            onConnection(connId)
          }
        })
        try {
          return await longCall<{ port: number }>(Methods.tunnelListen, [listenerId])
        } catch (err) {
          this.rpc.unregisterStream(listenerId)
          throw err
        }
      },
      stopListen: (listenerId) => {
        void this.rpc.call(Methods.tunnelStopListen, [listenerId]).catch(() => {})
        this.rpc.unregisterStream(listenerId)
      },
    }

    this.file = {
      readFile: (p, access) => call<string>(Methods.fileReadFile, [p, scoped(access)]),
      readBinary: async (p, access) =>
        Buffer.from(await call<string>(Methods.fileReadBinary, [p, scoped(access)]), 'base64'),
      writeFile: (p, content, access) => call<string>(Methods.fileWriteFile, [p, content, scoped(access)]),
      writeBinary: (p, data, access) => longCall<string>(Methods.fileWriteBinary, [p, data.toString('base64'), scoped(access)]),
      readDir: (p, access) => call<FileTreeNode[]>(Methods.fileReadDir, [p, scoped(access)]),
      stat: (p, access) => call<{ isDirectory: boolean; isFile: boolean }>(Methods.fileStat, [p, scoped(access)]),
      remove: (p, access) => call<void>(Methods.fileRemove, [p, scoped(access)]),
      rename: (oldP, newP, access) => call<string>(Methods.fileRename, [oldP, newP, scoped(access)]),
      mkdir: (p, access) => call<void>(Methods.fileMkdir, [p, scoped(access)]),
      copy: (src, destDir, access) => call<string>(Methods.fileCopy, [src, destDir, scoped(access)]),
      extensionsRoot: () => call<string>(Methods.fileExtensionsRoot, []),
      // longCall (no deadline): extraction shells `tar` on the host and can run
      // past the default 30s call timeout for a large extension.
      extractArtifact: (tgz, destDir) => longCall<string>(Methods.fileExtractArtifact, [tgz, destDir]),
      importEntries: (sources, destDir, mode, access) =>
        call<{ created: string[]; failed: number }>(Methods.fileImportEntries, [sources, destDir, mode, scoped(access)]),
      search: (root, query, opts, access) =>
        longCall<FileSearchResult[]>(Methods.fileSearch, [root, query, opts, scoped(access)]),
      searchContent: (root, opts, cbs, access) => {
        // Server-assigned streamId, like watch: start, then register the stream
        // when the round-trip resolves. batch/done arrive as evt frames.
        let streamId: string | null = null
        let stopped = false
        void call<string>(Methods.fileSearchContentStart, [root, opts, scoped(access)]).then((id) => {
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
      watch: (prefix, onChange, access) => {
        let streamId: string | null = null
        let stopped = false
        void call<string>(Methods.fileWatchStart, [prefix, scoped(access)]).then((id) => {
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
      isRepo: (dir, access) => call<boolean>(Methods.vcsIsRepo, [dir, scoped(access)]),
      findRepos: (dir, maxDepth, access) => call<string[]>(Methods.vcsFindRepos, [dir, maxDepth, scoped(access)]),
      init: (dir, access) => call<void>(Methods.vcsInit, [dir, scoped(access)]),
      lsFiles: (dir, access) => call<string[]>(Methods.vcsLsFiles, [dir, scoped(access)]),
      status: (cwd, access) => call<GitStatusResult>(Methods.vcsStatus, [cwd, scoped(access)]),
      diff: (cwd, filePath, access) => call<string>(Methods.vcsDiff, [cwd, filePath, scoped(access)]),
      diffStaged: (cwd, filePath, access) => call<string>(Methods.vcsDiffStaged, [cwd, filePath, scoped(access)]),
      monitorStatus: (cwd, access) => call<MonitorStatusResult>(Methods.vcsMonitorStatus, [cwd, scoped(access)]),
      stage: (cwd, filePath, access) => call<void>(Methods.vcsStage, [cwd, filePath, scoped(access)]),
      unstage: (cwd, filePath, access) => call<void>(Methods.vcsUnstage, [cwd, filePath, scoped(access)]),
      commit: (cwd, message, access) => call<void>(Methods.vcsCommit, [cwd, message, scoped(access)]),
      push: (cwd, remote, branch, access) => longCall<void>(Methods.vcsPush, [cwd, remote, branch, scoped(access)]),
      pull: (cwd, remote, branch, access) => longCall<GitPullResult>(Methods.vcsPull, [cwd, remote, branch, scoped(access)]),
      fetch: (cwd, remote, access) => longCall<void>(Methods.vcsFetch, [cwd, remote, scoped(access)]),
      log: (cwd, maxCount, access) => call<GitLogEntry[]>(Methods.vcsLog, [cwd, maxCount, scoped(access)]),
      branchList: (cwd, access) => call<GitBranchListResult>(Methods.vcsBranchList, [cwd, scoped(access)]),
      branchCreate: (cwd, name, startPoint, access) => call<void>(Methods.vcsBranchCreate, [cwd, name, startPoint, scoped(access)]),
      branchDelete: (cwd, name, force, access) => call<void>(Methods.vcsBranchDelete, [cwd, name, force, scoped(access)]),
      checkout: (cwd, branch, access) => call<void>(Methods.vcsCheckout, [cwd, branch, scoped(access)]),
      stash: (cwd, message, access) => call<void>(Methods.vcsStash, [cwd, message, scoped(access)]),
      stashPop: (cwd, access) => call<void>(Methods.vcsStashPop, [cwd, scoped(access)]),
      discardFile: (cwd, filePath, access) => call<void>(Methods.vcsDiscardFile, [cwd, filePath, scoped(access)]),
      worktreeList: (cwd, access) => call<Worktree[]>(Methods.vcsWorktreeList, [cwd, scoped(access)]),
      worktreeAdd: (repoCwd, branch, target, options, access) =>
        call<{ path: string; branch: string }>(Methods.vcsWorktreeAdd, [repoCwd, branch, target, options, scoped(access)]),
      worktreeAddFromPr: (repoCwd, pr, target, options, access) =>
        longCall<{ path: string; branch: string }>(Methods.vcsWorktreeAddFromPr, [repoCwd, pr, target, options, scoped(access)]),
      worktreeRemove: (repoCwd, worktreePath, options, access) =>
        call<void>(Methods.vcsWorktreeRemove, [repoCwd, worktreePath, options, scoped(access)]),
      worktreePrune: (repoCwd, access) => call<{ output: string }>(Methods.vcsWorktreePrune, [repoCwd, scoped(access)]),
      worktreeStatus: (worktreePath, access) => call<WorktreeStatusResult | null>(Methods.vcsWorktreeStatus, [worktreePath, scoped(access)]),
      worktreeMergeTo: (repoCwd, from, to, access) => call<MergeResult>(Methods.vcsWorktreeMergeTo, [repoCwd, from, to, scoped(access)]),
      worktreeUpdateFrom: (worktreePath, from, access) => call<MergeResult>(Methods.vcsWorktreeUpdateFrom, [worktreePath, from, scoped(access)]),
      createPr: (worktreePath, branch, access) => longCall<CreatePrResult>(Methods.vcsCreatePr, [worktreePath, branch, scoped(access)]),
      prStatus: (worktreePath, branch, access) => longCall<PrStatusResult | null>(Methods.vcsPrStatus, [worktreePath, branch, scoped(access)]),
      prList: (repoCwd, access) => longCall<PrSummary[]>(Methods.vcsPrList, [repoCwd, scoped(access)]),
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
