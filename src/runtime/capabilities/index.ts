// =============================================================================
// buildDaemonRuntime — assembles a Runtime from the electron-free file +
// vcs capabilities, for the standalone daemon to host. The same FileHost/VcsHost
// the local process uses, wired with the daemon's configured exclusion set and
// process.env. Validation uses the electron-free pathValidation module; the
// daemon registers its workspace root via addAllowedRoot at startup.
// =============================================================================

import { existsSync } from 'fs'
import path from 'path'
import * as fileLeaf from './file'
import { createWatchPool } from './fileWatcher'
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
import type { Runtime, FileHost } from '../../main/runtime/types'

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

  // ONE place for workspace-tree watching: the shared @parcel/watcher pool. It
  // owns covering-root sharing, prefix fan-out, native exclusion pruning, and
  // error containment (a broken tree is dropped, never crashes the daemon).
  // `getExclusions` reads the daemon's live set, so refresh() (below) re-applies
  // setExclusions to active watchers.
  const watchPool = createWatchPool(() => exclusionSet)

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
    // watch returns its unsub synchronously and delivers parcel's native
    // create/update/delete to the client (so it can prune removed entries, not
    // just re-read). The root is authoritative-validated here (sync lexical
    // check) before the pool watches it; parcel's `ignore` prunes the daemon's
    // exclusionSet + hidden dirs so the watcher never floods on node_modules/.git.
    watch: (prefix, onChange) => watchPool.subscribe(validatePath(prefix), onChange),
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
    // Active watchers fixed their parcel `ignore` list at subscribe time, so
    // rebuild each one against the new set via the pool's refresh().
    setExclusions: async (names) => {
      exclusionSet.clear()
      for (const name of names) exclusionSet.add(name)
      await watchPool.refresh()
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
