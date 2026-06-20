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
  VcsHost,
} from './types'

export class DeferredRuntime implements Runtime {
  readonly process: ProcessHost
  readonly agent: AgentHost
  readonly file: FileHost
  readonly vcs: VcsHost

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

    this.file = {
      readFile: (p) => d((c) => c.file.readFile(p)),
      readBinary: (p) => d((c) => c.file.readBinary(p)),
      writeFile: (p, content) => d((c) => c.file.writeFile(p, content)),
      writeBinary: (p, data) => d((c) => c.file.writeBinary(p, data)),
      readDir: (p) => d((c) => c.file.readDir(p)),
      stat: (p) => d((c) => c.file.stat(p)),
      remove: (p) => d((c) => c.file.remove(p)),
      rename: (oldP, newP) => d((c) => c.file.rename(oldP, newP)),
      mkdir: (p) => d((c) => c.file.mkdir(p)),
      copy: (src, destDir) => d((c) => c.file.copy(src, destDir)),
      importEntries: (sources, destDir, mode, winId) => d((c) => c.file.importEntries(sources, destDir, mode, winId)),
      search: (root, query, opts) => d((c) => c.file.search(root, query, opts)),
      // Start-after-ready: return the cancel handle now; start the real search
      // once ready unless cancelled. Mirrors RemoteRuntime.file.searchContent.
      searchContent: (root, opts, cbs) => {
        let stopped = false
        let handle: { cancel: () => void } | null = null
        ready_.then((c) => {
          if (stopped) return
          handle = c.file.searchContent(root, opts, cbs)
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
      watch: (prefix, onChange) => {
        let stopped = false
        let realUnsub: (() => void) | null = null
        ready_.then((c) => {
          if (stopped) return
          realUnsub = c.file.watch(prefix, onChange)
        }).catch(() => { /* watch failed to start; no events */ })
        return () => {
          stopped = true
          if (realUnsub) { realUnsub(); realUnsub = null }
        }
      },
    }

    this.vcs = {
      isRepo: (dir) => d((c) => c.vcs.isRepo(dir)),
      init: (dir) => d((c) => c.vcs.init(dir)),
      lsFiles: (dir) => d((c) => c.vcs.lsFiles(dir)),
      status: (cwd) => d((c) => c.vcs.status(cwd)),
      diff: (cwd, filePath) => d((c) => c.vcs.diff(cwd, filePath)),
      diffStaged: (cwd, filePath) => d((c) => c.vcs.diffStaged(cwd, filePath)),
      monitorStatus: (cwd) => d((c) => c.vcs.monitorStatus(cwd)),
      stage: (cwd, filePath) => d((c) => c.vcs.stage(cwd, filePath)),
      unstage: (cwd, filePath) => d((c) => c.vcs.unstage(cwd, filePath)),
      commit: (cwd, message) => d((c) => c.vcs.commit(cwd, message)),
      push: (cwd, remote, branch) => d((c) => c.vcs.push(cwd, remote, branch)),
      pull: (cwd, remote, branch) => d((c) => c.vcs.pull(cwd, remote, branch)),
      fetch: (cwd, remote) => d((c) => c.vcs.fetch(cwd, remote)),
      log: (cwd, maxCount) => d((c) => c.vcs.log(cwd, maxCount)),
      branchList: (cwd) => d((c) => c.vcs.branchList(cwd)),
      branchCreate: (cwd, name, startPoint) => d((c) => c.vcs.branchCreate(cwd, name, startPoint)),
      branchDelete: (cwd, name, force) => d((c) => c.vcs.branchDelete(cwd, name, force)),
      checkout: (cwd, branch) => d((c) => c.vcs.checkout(cwd, branch)),
      stash: (cwd, message) => d((c) => c.vcs.stash(cwd, message)),
      stashPop: (cwd) => d((c) => c.vcs.stashPop(cwd)),
      discardFile: (cwd, filePath) => d((c) => c.vcs.discardFile(cwd, filePath)),
      worktreeList: (cwd) => d((c) => c.vcs.worktreeList(cwd)),
      worktreeAdd: (repoCwd, branch, target, options) => d((c) => c.vcs.worktreeAdd(repoCwd, branch, target, options)),
      worktreeAddFromPr: (repoCwd, pr, target, options) => d((c) => c.vcs.worktreeAddFromPr(repoCwd, pr, target, options)),
      worktreeRemove: (repoCwd, worktreePath, options) => d((c) => c.vcs.worktreeRemove(repoCwd, worktreePath, options)),
      worktreePrune: (repoCwd) => d((c) => c.vcs.worktreePrune(repoCwd)),
      worktreeStatus: (worktreePath) => d((c) => c.vcs.worktreeStatus(worktreePath)),
      worktreeMergeTo: (repoCwd, from, to) => d((c) => c.vcs.worktreeMergeTo(repoCwd, from, to)),
      worktreeUpdateFrom: (worktreePath, from) => d((c) => c.vcs.worktreeUpdateFrom(worktreePath, from)),
      createPr: (worktreePath, branch) => d((c) => c.vcs.createPr(worktreePath, branch)),
      prStatus: (worktreePath, branch) => d((c) => c.vcs.prStatus(worktreePath, branch)),
      prList: (repoCwd) => d((c) => c.vcs.prList(repoCwd)),
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
