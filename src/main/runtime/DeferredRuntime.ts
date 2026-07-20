// =============================================================================
// DeferredRuntime — a Runtime proxy registered SYNCHRONOUSLY while the real
// runtime (the LOCAL daemon) connects in the background. It lets the window
// paint immediately on first run: `resolve(LOCAL)` returns this proxy right
// away, and every op queues behind the `ready` promise that resolves to the
// real RemoteRuntime once the daemon is online.
//
// Shape rules (mirror RemoteRuntime's client-side behavior):
//   - validatePath / validateCwd are SYNC pass-throughs (the authoritative
//     check is the daemon's async validatePath*; never block the call site).
//   - every async method awaits `ready` then delegates. If `ready` rejects
//     (daemon failed to start) the async methods reject with that error — a
//     clear failure, not a confusing "No runtime registered".
//   - void-returning process/agent ops are fire-and-forget after ready.
//   - the two sync-returning streaming ops (file.watch / file.searchContent)
//     return a handle immediately and start the real op once ready, exactly as
//     RemoteRuntime does for its own async start.
// =============================================================================

import type { RuntimeId } from './locator'
import type {
  Runtime,
  FileHost,
  ProcessHost,
  AgentHost,
  AgentHookHost,
  ServerHost,
  TunnelHost,
  VcsHost,
} from './types'

export class DeferredRuntime implements Runtime {
  readonly process: ProcessHost
  readonly agent: AgentHost
  readonly agentHooks: AgentHookHost
  readonly file: FileHost
  readonly vcs: VcsHost
  readonly server: ServerHost
  readonly tunnel: TunnelHost

  constructor(
    readonly id: RuntimeId,
    private readonly ready: Promise<Runtime>,
  ) {
    const ready_ = this.ready
    // Await ready, then call the same method on the real runtime.
    const d = <T>(fn: (c: Runtime) => Promise<T>): Promise<T> => ready_.then(fn)

    this.process = {
      create: (opts, onData, onExit) => d((c) => c.process.create(opts, onData, onExit)),
      write: (id, data) => { void ready_.then((c) => c.process.write(id, data)).catch(() => {}) },
      resize: (id, cols, rows) => { void ready_.then((c) => c.process.resize(id, cols, rows)).catch(() => {}) },
      kill: (id) => { void ready_.then((c) => c.process.kill(id)).catch(() => {}) },
      getCwd: (id) => d((c) => c.process.getCwd(id)),
      setVisibility: (id, visible) => { void ready_.then((c) => c.process.setVisibility(id, visible)).catch(() => {}) },
      scanActivity: (ids) => d((c) => c.process.scanActivity(ids)),
      scanPorts: (ids) => d((c) => c.process.scanPorts(ids)),
    }

    this.agent = {
      ensurePi: () => d((c) => c.agent.ensurePi()),
      start: (opts, onLine, onExit) => d((c) => c.agent.start(opts, onLine, onExit)),
      writeLine: (id, line) => { void ready_.then((c) => c.agent.writeLine(id, line)).catch(() => {}) },
      stop: (id) => { void ready_.then((c) => c.agent.stop(id)).catch(() => {}) },
    }

    this.agentHooks = {
      // Start-after-ready: return the unsub now; start the real subscription
      // once ready unless unsubscribed. Mirrors RemoteRuntime.agentHooks.
      subscribe: (onEvent) => {
        let stopped = false
        let realUnsub: (() => void) | null = null
        ready_.then((c) => {
          if (stopped) return
          realUnsub = c.agentHooks.subscribe(onEvent)
        }).catch(() => { /* subscribe failed; no events */ })
        return () => {
          stopped = true
          if (realUnsub) { realUnsub(); realUnsub = null }
        }
      },
    }

    this.server = {
      start: (opts, onOutput, onExit) => d((c) => c.server.start(opts, onOutput, onExit)),
      stop: (id) => { void ready_.then((c) => c.server.stop(id)).catch(() => {}) },
    }

    this.tunnel = {
      open: (connId, port, onData, onClose) => d((c) => c.tunnel.open(connId, port, onData, onClose)),
      write: (connId, chunkB64) => { void ready_.then((c) => c.tunnel.write(connId, chunkB64)).catch(() => {}) },
      ack: (connId, byteCount) => { void ready_.then((c) => c.tunnel.ack(connId, byteCount)).catch(() => {}) },
      close: (connId) => { void ready_.then((c) => c.tunnel.close(connId)).catch(() => {}) },
      listen: (listenerId, onConnection, onData, onClose) => d((c) => c.tunnel.listen(listenerId, onConnection, onData, onClose)),
      stopListen: (listenerId) => { void ready_.then((c) => c.tunnel.stopListen(listenerId)).catch(() => {}) },
    }

    this.file = {
      readFile: (p, access) => d((c) => c.file.readFile(p, access)),
      readBinary: (p, access) => d((c) => c.file.readBinary(p, access)),
      writeFile: (p, content, access) => d((c) => c.file.writeFile(p, content, access)),
      writeBinary: (p, data, access) => d((c) => c.file.writeBinary(p, data, access)),
      readDir: (p, access) => d((c) => c.file.readDir(p, access)),
      stat: (p, access) => d((c) => c.file.stat(p, access)),
      remove: (p, access) => d((c) => c.file.remove(p, access)),
      rename: (oldP, newP, access) => d((c) => c.file.rename(oldP, newP, access)),
      mkdir: (p, access) => d((c) => c.file.mkdir(p, access)),
      copy: (src, destDir, access) => d((c) => c.file.copy(src, destDir, access)),
      extensionsRoot: () => d((c) => c.file.extensionsRoot()),
      extractArtifact: (tgz, destDir) => d((c) => c.file.extractArtifact(tgz, destDir)),
      importEntries: (sources, destDir, mode, access) => d((c) => c.file.importEntries(sources, destDir, mode, access)),
      search: (root, query, opts, access) => d((c) => c.file.search(root, query, opts, access)),
      // Start-after-ready: return the cancel handle now; start the real search
      // once ready unless cancelled. Mirrors RemoteRuntime.file.searchContent.
      searchContent: (root, opts, cbs, access) => {
        let stopped = false
        let handle: { cancel: () => void } | null = null
        ready_.then((c) => {
          if (stopped) return
          handle = c.file.searchContent(root, opts, cbs, access)
        }).catch((err) => {
          if (!stopped) cbs.onDone({ matches: 0, files: 0, truncated: false }, err instanceof Error ? err.message : String(err))
        })
        return {
          cancel: () => {
            stopped = true
            if (handle) { handle.cancel(); handle = null }
          },
        }
      },
      // Start-after-ready: return the unsub now; start the real watch once ready
      // unless unsubscribed. Mirrors RemoteRuntime.file.watch.
      watch: (prefix, onChange, access) => {
        let stopped = false
        let realUnsub: (() => void) | null = null
        ready_.then((c) => {
          if (stopped) return
          realUnsub = c.file.watch(prefix, onChange, access)
        }).catch(() => { /* watch failed to start; no events */ })
        return () => {
          stopped = true
          if (realUnsub) { realUnsub(); realUnsub = null }
        }
      },
    }

    this.vcs = {
      isRepo: (dir, access) => d((c) => c.vcs.isRepo(dir, access)),
      findRepos: (dir, maxDepth, access) => d((c) => c.vcs.findRepos(dir, maxDepth, access)),
      init: (dir, access) => d((c) => c.vcs.init(dir, access)),
      lsFiles: (dir, access) => d((c) => c.vcs.lsFiles(dir, access)),
      status: (cwd, access) => d((c) => c.vcs.status(cwd, access)),
      diff: (cwd, filePath, access) => d((c) => c.vcs.diff(cwd, filePath, access)),
      diffStaged: (cwd, filePath, access) => d((c) => c.vcs.diffStaged(cwd, filePath, access)),
      monitorStatus: (cwd, access) => d((c) => c.vcs.monitorStatus(cwd, access)),
      stage: (cwd, filePath, access) => d((c) => c.vcs.stage(cwd, filePath, access)),
      unstage: (cwd, filePath, access) => d((c) => c.vcs.unstage(cwd, filePath, access)),
      commit: (cwd, message, access) => d((c) => c.vcs.commit(cwd, message, access)),
      push: (cwd, remote, branch, access) => d((c) => c.vcs.push(cwd, remote, branch, access)),
      pull: (cwd, remote, branch, access) => d((c) => c.vcs.pull(cwd, remote, branch, access)),
      fetch: (cwd, remote, access) => d((c) => c.vcs.fetch(cwd, remote, access)),
      log: (cwd, maxCount, access) => d((c) => c.vcs.log(cwd, maxCount, access)),
      branchList: (cwd, access) => d((c) => c.vcs.branchList(cwd, access)),
      branchCreate: (cwd, name, startPoint, access) => d((c) => c.vcs.branchCreate(cwd, name, startPoint, access)),
      branchDelete: (cwd, name, force, access) => d((c) => c.vcs.branchDelete(cwd, name, force, access)),
      checkout: (cwd, branch, access) => d((c) => c.vcs.checkout(cwd, branch, access)),
      stash: (cwd, message, access) => d((c) => c.vcs.stash(cwd, message, access)),
      stashPop: (cwd, access) => d((c) => c.vcs.stashPop(cwd, access)),
      discardFile: (cwd, filePath, access) => d((c) => c.vcs.discardFile(cwd, filePath, access)),
      worktreeList: (cwd, access) => d((c) => c.vcs.worktreeList(cwd, access)),
      worktreeAdd: (repoCwd, branch, target, options, access) => d((c) => c.vcs.worktreeAdd(repoCwd, branch, target, options, access)),
      worktreeAddFromPr: (repoCwd, pr, target, options, access) => d((c) => c.vcs.worktreeAddFromPr(repoCwd, pr, target, options, access)),
      worktreeRemove: (repoCwd, worktreePath, options, access) => d((c) => c.vcs.worktreeRemove(repoCwd, worktreePath, options, access)),
      worktreePrune: (repoCwd, access) => d((c) => c.vcs.worktreePrune(repoCwd, access)),
      worktreeStatus: (worktreePath, access) => d((c) => c.vcs.worktreeStatus(worktreePath, access)),
      worktreeMergeTo: (repoCwd, from, to, access) => d((c) => c.vcs.worktreeMergeTo(repoCwd, from, to, access)),
      worktreeUpdateFrom: (worktreePath, from, access) => d((c) => c.vcs.worktreeUpdateFrom(worktreePath, from, access)),
      createPr: (worktreePath, branch, access) => d((c) => c.vcs.createPr(worktreePath, branch, access)),
      prStatus: (worktreePath, branch, access) => d((c) => c.vcs.prStatus(worktreePath, branch, access)),
      prList: (repoCwd, access) => d((c) => c.vcs.prList(repoCwd, access)),
    }
  }

  // SYNC pass-throughs — identical to RemoteRuntime: the authoritative check
  // is the daemon's async validatePath* run inside each leaf op. Never block.
  validatePath(filePath: string): string {
    return filePath
  }

  validateCwd(cwd: string): string {
    return cwd
  }

  validatePathStrict(filePath: string, ownerWindowId?: number, scopeId?: string): Promise<string> {
    return this.ready.then((c) => c.validatePathStrict(filePath, ownerWindowId, scopeId))
  }

  validatePathForCreation(filePath: string, ownerWindowId?: number, scopeId?: string): Promise<string> {
    return this.ready.then((c) => c.validatePathForCreation(filePath, ownerWindowId, scopeId))
  }

  addAllowedRoot(root: string, scopeId?: string): Promise<void> {
    return this.ready.then((c) => c.addAllowedRoot(root, scopeId))
  }

  removeAllowedRoot(root: string, scopeId?: string): Promise<void> {
    return this.ready.then((c) => c.removeAllowedRoot(root, scopeId))
  }

  setExclusions(names: string[]): Promise<void> {
    return this.ready.then((c) => c.setExclusions(names))
  }

  setIdleSuspend(enabled: boolean): Promise<void> {
    return this.ready.then((c) => c.setIdleSuspend(enabled))
  }

  grantFileAccess(filePath: string, ownerWindowId: number): Promise<void> {
    return this.ready.then((c) => c.grantFileAccess(filePath, ownerWindowId))
  }

  registerScopedWriteAllowance(safePath: string, ownerWindowId: number): Promise<void> {
    return this.ready.then((c) => c.registerScopedWriteAllowance(safePath, ownerWindowId))
  }

  clearFileGrantsForWindow(windowId: number): Promise<void> {
    return this.ready.then((c) => c.clearFileGrantsForWindow(windowId))
  }

  clearScopedWriteAllowancesForWindow(windowId: number): Promise<void> {
    return this.ready.then((c) => c.clearScopedWriteAllowancesForWindow(windowId))
  }
}
