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
import { createServerCapability, type ServerCapability } from './server'
import { createTunnelCapability, type TunnelCapability } from './tunnel'
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

/** A built daemon Runtime plus the concrete process/server/tunnel capabilities,
 *  so the daemon entry can reap children on shutdown (killAllGroups / killAll /
 *  closeAll — none of which are part of the portable host interfaces). */
export interface DaemonRuntime {
  runtime: Runtime
  process: ProcessCapability
  server: ServerCapability
  tunnel: TunnelCapability
  /** Reap every live server child + tunnel socket (servers + tunnels). Process
   *  groups are reaped via `process.killAllGroups()` by the daemon entry. */
  killAll(): void
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

  // Registry of active fs-watch subscriptions, so setExclusions can rebuild each
  // with the new ignore list. Keyed by a unique handle (an object identity) so a
  // concurrent unsub during a rebuild removes exactly its own entry.
  interface WatchEntry {
    prefix: string
    onChange: (changedPath: string, type: FsChangeType) => void
    watcher: ReturnType<typeof watch>
  }
  const activeWatches = new Set<WatchEntry>()

  // Create a chokidar watcher for `prefix` with the CURRENT ignore list, wiring
  // its add/change/unlink to onChange. Used on first watch and on every rebuild.
  const spawnWatcher = (prefix: string, onChange: (changedPath: string, type: FsChangeType) => void) => {
    // Full-tree watch (no `depth` cap) — clients assume events for nested
    // paths; the ignore matcher prunes hidden/excluded subtrees.
    const root = validatePath(prefix)
    const w = watch(root, { ignoreInitial: true, ignored: buildIgnored(root) })
    w.on('add', (fp) => onChange(fp, 'create'))
    w.on('change', (fp) => onChange(fp, 'update'))
    w.on('unlink', (fp) => onChange(fp, 'delete'))
    return w
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
      // The watcher is tracked in activeWatches so setExclusions can rebuild it
      // with a fresh ignore list — the chokidar `ignored` is fixed at creation,
      // so a live exclusion change must recreate the watcher.
      const entry: WatchEntry = { prefix, onChange, watcher: spawnWatcher(prefix, onChange) }
      activeWatches.add(entry)
      return () => {
        // Remove from the registry FIRST so a concurrent setExclusions rebuild
        // never resurrects a just-unsubscribed watcher.
        activeWatches.delete(entry)
        void entry.watcher.close()
      }
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

  // Server-backed extensions: spawn the server child on the daemon host, bound
  // to a daemon-loopback port; the tunnel bridges raw TCP to that port. Both are
  // electron-free and share the daemon's clean env.
  const server = createServerCapability({ baseEnv: cleanEnv, daemonId: config.id })
  const tunnel = createTunnelCapability()

  const runtime: Runtime = {
    id: config.id,
    process: proc,
    agent,
    file,
    vcs,
    server,
    tunnel,
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
      // Snapshot first: rebuilding mutates nothing in activeWatches (we swap the
      // watcher field in place), but an unsub during this loop deletes its entry,
      // so iterating a snapshot + re-checking membership avoids reviving it.
      // Close the OLD watcher fully before the swap is considered done, so it
      // can't keep emitting events for newly-excluded names during the overlap.
      await Promise.all(
        [...activeWatches].map(async (entry) => {
          if (!activeWatches.has(entry)) return // unsubscribed concurrently
          const old = entry.watcher
          entry.watcher = spawnWatcher(entry.prefix, entry.onChange)
          // The entry may have been unsubscribed while we were swapping; if so its
          // new watcher must also be closed (the unsub already closed the old one).
          if (!activeWatches.has(entry)) void entry.watcher.close()
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
  return {
    runtime,
    process: proc,
    server,
    tunnel,
    killAll: () => { server.killAll(); tunnel.closeAll() },
  }
}
