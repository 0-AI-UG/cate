// =============================================================================
// buildDaemonCompanion — assembles a Companion from the electron-free file +
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
} from '../../main/ipc/pathValidation'
import type { Companion, FileHost } from '../../main/companion/types'

export interface DaemonCompanionConfig {
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

/** A built daemon Companion plus the concrete process capability, so the daemon
 *  entry can call killAllGroups() on shutdown (not part of the ProcessHost interface). */
export interface DaemonCompanion {
  companion: Companion
  process: ProcessCapability
}

/** The ripgrep binary shipped in the companion tarball, staged next to the
 *  bundled node runtime. The daemon runs as `runtime/bin/node[.exe] companion.cjs`,
 *  so process.execPath is runtime/bin/node[.exe] and `rg[.exe]` is its sibling.
 *  Unified layout: only the filename differs on win32. */
function daemonRgPath(): string {
  return path.join(path.dirname(process.execPath), process.platform === 'win32' ? 'rg.exe' : 'rg')
}

export function buildDaemonCompanion(config: DaemonCompanionConfig): DaemonCompanion {
  const exclusionSet = new Set(config.exclusions ?? [])
  const rgPath = config.rgPath ?? daemonRgPath()

  // The daemon is the AUTHORITATIVE path check: only it can realpath its own
  // filesystem, and RemoteCompanion's client-side validate* are pass-throughs.
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
      // Mirror the in-process createWatcher: hidden dotfiles + the daemon's
      // exclusionSet (two globs per name) and a depth cap, so the watcher never
      // floods with node_modules/.git events. Electron-free (no getSettingSync).
      const ignored: Array<RegExp | string> = [
        /(^|[/\\])\../, // hidden files
        ...[...exclusionSet].flatMap((name) => [`**/${name}`, `**/${name}/**`]),
      ]
      const w = watch(validatePath(prefix), { ignoreInitial: true, depth: 1, ignored })
      w.on('add', (fp) => onChange(fp, 'create'))
      w.on('change', (fp) => onChange(fp, 'update'))
      w.on('unlink', (fp) => onChange(fp, 'delete'))
      return () => { void w.close() }
    },
  }

  const env = config.env ?? (() => process.env)
  const vcs = createVcsCapability({ env })

  // Daemon shell resolution: first existing of [requested, $SHELL, bash, sh]
  // (or, on Windows, [requested, %COMSPEC%, powershell.exe, cmd.exe]). Verifying
  // existence avoids an execvp ENOENT (e.g. a stale $SHELL, or a shell path
  // forwarded from a different-OS client) — we fall back with a notice.
  const innerProc = createProcessCapability({
    resolveShell: (requested) => {
      if (process.platform === 'win32') {
        const candidates = [requested, process.env.COMSPEC, 'powershell.exe', 'cmd.exe'].filter(Boolean) as string[]
        // COMSPEC/cmd.exe are absolute (existsSync works); powershell.exe is on
        // PATH (existsSync on a bare name is false), so it's a sensible default
        // rather than something we can stat — fall back to cmd.exe if nothing
        // absolute exists, letting CreateProcess resolve it via PATH.
        const found = candidates.find((p) => existsSync(p))
        if (found) {
          const notice = requested && found !== requested ? `Shell "${requested}" not found; using ${found}\r\n` : undefined
          return { path: found, args: [], notice }
        }
        return { path: 'cmd.exe', args: [] }
      }
      const candidates = [requested, process.env.SHELL, '/bin/bash', '/bin/sh'].filter(Boolean) as string[]
      const found = candidates.find((p) => existsSync(p))
      if (found) {
        const notice = requested && found !== requested ? `Shell "${requested}" not found; using ${found}\r\n` : undefined
        return { path: found, args: [], notice }
      }
      // Last resort: let execvp try /bin/sh by name (PATH lookup).
      return { path: 'sh', args: [] }
    },
    getEnv: () => Object.fromEntries(Object.entries(env()).filter(([, v]) => v !== undefined)) as Record<string, string>,
    idleSuspend: config.idleSuspend,
  })

  // The daemon is the AUTHORITATIVE cwd check (RemoteCompanion.validateCwd is a
  // client-side pass-through), so validate the terminal cwd here before spawning,
  // matching what terminal.ts does for a local companion. Throwing rejects create.
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
  // bundled node (process.execPath == the companion's runtime node here).
  const agent = createAgentCapability({
    ensurePi: ensurePiOnHost,
    piCliPath,
    nodeBin: () => process.execPath,
    baseEnv: () => Object.fromEntries(Object.entries(env()).filter(([, v]) => v !== undefined)) as Record<string, string>,
  })

  const companion: Companion = {
    id: config.id,
    process: proc,
    agent,
    file,
    vcs,
    validatePath,
    validatePathStrict,
    validatePathForCreation,
    validateCwd,
    addAllowedRoot: async (root) => { addRoot(root) },
    removeAllowedRoot: async (root) => { removeRoot(root) },
    // Mutate the existing Set IN PLACE so the readDir/search closures that
    // captured this reference see the new exclusions live (do NOT reassign).
    // Active chokidar watchers built their `ignored` list at watch-creation time
    // and won't pick up the change until re-created — acceptable, since the
    // user-visible tree readDir + file-name search update immediately.
    setExclusions: async (names) => {
      exclusionSet.clear()
      for (const name of names) exclusionSet.add(name)
    },
    setIdleSuspend: async (enabled) => { proc.setIdleSuspend(enabled) },
    // pathValidation's functions take (windowId, path); the Companion contract
    // (and the wire) is (path, windowId) — swap here.
    grantFileAccess: async (filePath, ownerWindowId) => { await grantFile(ownerWindowId, filePath) },
    registerScopedWriteAllowance: async (safePath, ownerWindowId) => { await registerWriteAllowance(ownerWindowId, safePath) },
  }
  return { companion, process: proc }
}
