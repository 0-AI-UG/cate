// =============================================================================
// buildDaemonRuntime — assembles a Runtime from the electron-free file +
// vcs capabilities, for the standalone daemon to host. The same FileHost/VcsHost
// the local process uses, wired with the daemon's configured exclusion set and
// process.env. Validation uses the electron-free pathValidation module; the
// daemon registers its workspace root via addAllowedRoot at startup.
// =============================================================================

import { watch } from 'chokidar'
import { existsSync } from 'fs'
import path from 'path'
import * as fileLeaf from './file'
import { runRipgrepSearch } from '../search/engine'
import { createVcsCapability } from './vcs'
import { createProcessCapability, type ProcessCapability } from './process'
import { createAgentCapability } from './agent'
import { ensurePiOnHost, piCliPath } from '../ensurePi'
import {
  validatePath,
  validatePathStrict,
  validatePathForCreation,
  validateCwd,
  addAllowedRoot as addRoot,
  removeAllowedRoot as removeRoot,
  grantFileAccess as grantFile,
  registerScopedWriteAllowance as registerWriteAllowance,
  clearFileGrantsForWindow as clearFileGrants,
  clearScopedWriteAllowancesForWindow as clearWriteAllowances,
} from '../../main/ipc/pathValidation'
import type { Runtime, FileHost, FsChangeType } from '../../main/runtime/types'

export interface DaemonRuntimeConfig {
  id: string
  /** Basenames to hide in readDir/search (the daemon's mirror of fileExclusions). */
  exclusions?: string[]
  /** Env for git/gh subprocesses. Defaults to process.env. */
  env?: () => NodeJS.ProcessEnv
  /** POSIX-only idle-suspend of backgrounded local terminals (off for remote
   *  daemons — only the local-workspace daemon sets it, mirroring the in-process
   *  local host's setting). Passed through to the process capability. */
  idleSuspend?: boolean
  /** Override the ripgrep binary path for content search. Defaults to the rg
   *  shipped beside the daemon's node runtime (runtime/bin/rg). Tests inject a
   *  real rg here since they don't run under the bundled runtime layout. */
  rgPath?: string
}

/** A built daemon Runtime plus the concrete process capability, so the daemon
 *  entry can call killAllGroups() on shutdown (not part of the ProcessHost interface). */
export interface DaemonRuntime {
  runtime: Runtime
  process: ProcessCapability
}

/** The ripgrep binary shipped in the runtime tarball, staged next to the
 *  bundled node runtime. The daemon runs as `runtime/bin/node[.exe] runtime.cjs`,
 *  so process.execPath is runtime/bin/node[.exe] and `rg[.exe]` is its sibling.
 *  Unified layout: only the filename differs on win32. */
function daemonRgPath(): string {
  return path.join(path.dirname(process.execPath), process.platform === 'win32' ? 'rg.exe' : 'rg')
}

export function buildDaemonRuntime(config: DaemonRuntimeConfig): DaemonRuntime {
  const exclusionSet = new Set(config.exclusions ?? [])
  const rgPath = config.rgPath ?? daemonRgPath()

  // The chokidar ignore predicate: hidden dotfiles + the daemon's live
  // exclusionSet. Built fresh (snapshotting the CURRENT set) each time a
  // watcher is (re)created, so setExclusions takes effect on active watchers
  // via the rebuild below.
  const buildIgnored = (rootPath: string) => fileLeaf.createFsIgnoreMatcher(rootPath, new Set(exclusionSet))

  interface WatchSubscriber {
    prefix: string
    onChange: (changedPath: string, type: FsChangeType) => void
  }

  interface SharedWatch {
    root: string
    watcher: ReturnType<typeof watch>
    subscribers: Set<WatchSubscriber>
  }

  // One recursive chokidar instance can cover several runtime.file.watch()
  // subscribers under the same root. This keeps the local daemon from opening a
  // second full-tree watch for the git monitor, agent auth sync, and any future
  // nested subscriptions in the same workspace.
  //
  // Concurrency note: the SharedWatch object is still the identity token. Every
  // stale unsubscribe/error/rebuild path checks `watchPool.get(root) === shared`
  // before deleting or closing the current watcher, so an old handle cannot tear
  // down a newer watcher that reused the same root key.
  const watchPool = new Map<string, SharedWatch>()

  const pathHasPrefix = (filePath: string, prefix: string): boolean => {
    const fp = filePath.replace(/\\/g, '/')
    const pre = prefix.replace(/\\/g, '/')
    if (fp === pre) return true
    if (!fp.startsWith(pre)) return false
    const next = fp.charCodeAt(pre.length)
    return next === 47 /* / */ || next === 92 /* \ */
  }

  // Create a chokidar watcher for `prefix` with the CURRENT ignore list, wiring
  // its add/change/unlink to onChange. Used on first watch and on every rebuild.
  const spawnWatcher = (shared: SharedWatch) => {
    // Full-tree watch (no `depth` cap) — clients assume events for nested
    // paths; the ignore matcher prunes hidden/excluded subtrees.
    const w = watch(shared.root, { ignoreInitial: true, ignored: buildIgnored(shared.root) })
    const fanOut = (fp: string, type: FsChangeType) => {
      for (const sub of shared.subscribers) {
        if (pathHasPrefix(fp, sub.prefix)) sub.onChange(fp, type)
      }
    }
    w.on('add', (fp) => fanOut(fp, 'create'))
    w.on('change', (fp) => fanOut(fp, 'update'))
    w.on('unlink', (fp) => fanOut(fp, 'delete'))
    w.on('error', () => {
      // EMFILE/EPERM/etc. must not crash the daemon. Drop this broken watcher;
      // polling callers (for example git monitor) continue, and a later watch
      // request can attempt a fresh watcher.
      if (watchPool.get(shared.root) === shared && shared.watcher === w) {
        watchPool.delete(shared.root)
      }
      w.removeAllListeners()
      void w.close()
    })
    return w
  }

  const findCoveringWatch = (prefix: string): SharedWatch | null => {
    let best: SharedWatch | null = null
    for (const shared of watchPool.values()) {
      if (!pathHasPrefix(prefix, shared.root)) continue
      if (!best || shared.root.length > best.root.length) best = shared
    }
    return best
  }

  const subscribeWatch = (
    prefix: string,
    onChange: (changedPath: string, type: FsChangeType) => void,
  ): (() => void) => {
    const root = validatePath(prefix)
    let shared = findCoveringWatch(root)
    if (!shared) {
      shared = { root, watcher: null as never, subscribers: new Set<WatchSubscriber>() }
      shared.watcher = spawnWatcher(shared)
      watchPool.set(root, shared)
    }
    const sub: WatchSubscriber = { prefix: root, onChange }
    shared.subscribers.add(sub)

    return () => {
      sub.onChange = () => { /* unsubscribed */ }
      shared.subscribers.delete(sub)
      if (shared.subscribers.size > 0) return
      if (watchPool.get(shared.root) === shared) watchPool.delete(shared.root)
      void shared.watcher.close()
    }
  }

  // The daemon is the AUTHORITATIVE path check: only it can realpath its own
  // filesystem, and RemoteRuntime's client-side validate* are pass-throughs.
  // So every leaf op validates its path(s) against the daemon's allowed root
  // (addAllowedRoot(--root) at startup) here, before touching the fs. Reads use
  // the strict (symlink-resolving) check; creates use the parent-exists check.
  const file: FileHost = {
    readFile: async (p) => fileLeaf.readFile(await validatePathStrict(p)),
    readBinary: async (p) => fileLeaf.readBinary(await validatePathStrict(p)),
    writeFile: async (p, content) => fileLeaf.writeFile(await validatePathForCreation(p), content),
    writeBinary: async (p, data) => fileLeaf.writeBinary(await validatePathForCreation(p), data),
    readDir: async (p) => fileLeaf.readDir(await validatePathStrict(p), exclusionSet),
    stat: async (p) => fileLeaf.statEntry(await validatePathStrict(p)),
    remove: async (p) => fileLeaf.removeEntry(await validatePathStrict(p)),
    rename: async (oldP, newP) =>
      fileLeaf.renameEntry(await validatePathStrict(oldP), await validatePathForCreation(newP)),
    mkdir: async (p) => fileLeaf.mkdirEntry(await validatePathForCreation(p)),
    copy: async (src, destDir) =>
      fileLeaf.copyInto(await validatePathStrict(src), await validatePathStrict(destDir)),
    importEntries: async (sources, destDir, mode, winId) =>
      fileLeaf.importEntriesInto(sources, await validatePathStrict(destDir), mode, winId, () => { /* errors counted, not logged */ }),
    search: async (root, query, opts) =>
      fileLeaf.searchFiles(await validatePathStrict(root), query, exclusionSet, opts),
    // Content search spawns the ripgrep shipped beside the daemon's node
    // runtime (runtime/bin/rg, sibling of process.execPath = runtime/bin/node).
    // Uses the sync lexical root check, like watch — it returns a handle, not a
    // promise, and the spawn root must be authoritative-validated here.
    searchContent: (root, opts, cbs) =>
      runRipgrepSearch(rgPath, opts, validatePath(root), [...exclusionSet], cbs),
    watch: (prefix, onChange) => {
      // watch returns its unsub synchronously; use the cheap lexical check.
      // Map chokidar's events to the real change type so the client can prune
      // removed entries (not just re-read on every event).
      // Mirror the in-process createWatcher: the shared ignore matcher prunes
      // hidden dotfiles and the daemon's exclusionSet, so the watcher never
      // floods with node_modules/.git events. Electron-free (no getSettingSync).
      //
      // The shared watcher is tracked in watchPool so setExclusions can rebuild
      // it with a fresh ignore list — the chokidar `ignored` is fixed at
      // creation, so a live exclusion change must recreate the watcher.
      return subscribeWatch(prefix, onChange)
    },
  }

  const env = config.env ?? (() => process.env)
  const cleanEnv = () =>
    Object.fromEntries(Object.entries(env()).filter(([, v]) => v !== undefined)) as Record<string, string>
  const vcs = createVcsCapability({ env })

  // Daemon shell resolution: first existing of [requested, $SHELL, bash, sh]
  // (or, on Windows, [requested, %COMSPEC%, powershell.exe, cmd.exe]). Verifying
  // existence avoids an execvp ENOENT (e.g. a stale $SHELL, or a shell path
  // forwarded from a different-OS client) — we fall back with a notice.
  const innerProc = createProcessCapability({
    resolveShell: (requested) => {
      const fromCandidates = (candidates: string[]) => {
        const found = candidates.filter(Boolean).find((p) => existsSync(p))
        if (!found) return undefined
        const notice = requested && found !== requested ? `Shell "${requested}" not found; using ${found}\r\n` : undefined
        return { path: found, args: [], notice }
      }
      if (process.platform === 'win32') {
        // COMSPEC/cmd.exe are absolute (existsSync works); powershell.exe is on
        // PATH (existsSync on a bare name is false), so it's a sensible default
        // rather than something we can stat — fall back to cmd.exe if nothing
        // absolute exists, letting CreateProcess resolve it via PATH.
        return (
          fromCandidates([requested, process.env.COMSPEC, 'powershell.exe', 'cmd.exe'].filter(Boolean) as string[]) ?? {
            path: 'cmd.exe',
            args: [],
          }
        )
      }
      // Last resort: let execvp try /bin/sh by name (PATH lookup).
      return (
        fromCandidates([requested, process.env.SHELL, '/bin/bash', '/bin/sh'].filter(Boolean) as string[]) ?? {
          path: 'sh',
          args: [],
        }
      )
    },
    getEnv: cleanEnv,
    idleSuspend: config.idleSuspend,
  })

  // The daemon is the AUTHORITATIVE cwd check (RemoteRuntime.validateCwd is a
  // client-side pass-through), so validate the terminal cwd here before spawning,
  // matching what terminal.ts does for a local runtime. Throwing rejects create.
  // Keep it a ProcessCapability (spread carries killAllGroups) so the daemon
  // entry can reap process groups on shutdown.
  const proc: ProcessCapability = {
    ...innerProc,
    create: async (opts, onData, onExit) => {
      if (opts.cwd) validateCwd(opts.cwd) // throws -> rejects create, matching local
      return innerProc.create(opts, onData, onExit)
    },
  }

  // Agent: the daemon pulls the pi tarball to the host and runs it under the
  // bundled node (process.execPath == the runtime's runtime node here).
  const agent = createAgentCapability({
    ensurePi: ensurePiOnHost,
    piCliPath,
    nodeBin: () => process.execPath,
    baseEnv: cleanEnv,
  })

  const runtime: Runtime = {
    id: config.id,
    process: proc,
    agent,
    file,
    vcs,
    validatePath,
    validatePathStrict,
    validatePathForCreation,
    validateCwd,
    addAllowedRoot: async (root, scopeId) => { addRoot(root, scopeId) },
    removeAllowedRoot: async (root, scopeId) => { removeRoot(root, scopeId) },
    // Mutate the existing Set IN PLACE so the readDir/search closures that
    // captured this reference see the new exclusions live (do NOT reassign).
    // Active chokidar watchers fixed their `ignored` list at creation time, so
    // rebuild each one against the new set: close the old watcher and spawn a
    // fresh one (same prefix + onChange), swapping it into the registry entry.
    setExclusions: async (names) => {
      exclusionSet.clear()
      for (const name of names) exclusionSet.add(name)
      // Snapshot first: rebuilding swaps each SharedWatch's watcher field in
      // place, but an unsub during this loop deletes its pool entry, so
      // iterating a snapshot + re-checking object identity avoids reviving it.
      // Close the OLD watcher fully before the swap is considered done, so it
      // can't keep emitting events for newly-excluded names during the overlap.
      await Promise.all(
        [...watchPool.values()].map(async (shared) => {
          if (watchPool.get(shared.root) !== shared) return // unsubscribed concurrently
          const old = shared.watcher
          shared.watcher = spawnWatcher(shared)
          if (watchPool.get(shared.root) !== shared) void shared.watcher.close()
          old.removeAllListeners()
          await old.close()
        }),
      )
    },
    setIdleSuspend: async (enabled) => { proc.setIdleSuspend(enabled) },
    // pathValidation's functions take (windowId, path); the Runtime contract
    // (and the wire) is (path, windowId) — swap here.
    grantFileAccess: async (filePath, ownerWindowId) => { await grantFile(ownerWindowId, filePath) },
    registerScopedWriteAllowance: async (safePath, ownerWindowId) => { await registerWriteAllowance(ownerWindowId, safePath) },
    clearFileGrantsForWindow: async (windowId) => { clearFileGrants(windowId) },
    clearScopedWriteAllowancesForWindow: async (windowId) => { clearWriteAllowances(windowId) },
  }
  return { runtime, process: proc }
}
