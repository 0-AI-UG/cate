// =============================================================================
// buildDaemonRuntime — assembles a Runtime from the electron-free file +
// vcs capabilities, for the standalone daemon to host. The same FileHost/VcsHost
// the local process uses, wired with the daemon's configured exclusion set and
// process.env. Validation uses the electron-free pathValidation module; the
// daemon registers its workspace root via addAllowedRoot at startup.
// =============================================================================

import path from 'path'
import * as fileLeaf from './file'
import { hostExtensionsRoot, extractArtifact } from './extensions'
import { createWatchPool } from './fileWatcher'
import { runRipgrepSearch } from '../search/engine'
import { createVcsCapability } from './vcs'
import { createProcessCapability, type ProcessCapability } from './process'
import { resolveShell } from './shellResolver'
import { createAgentCapability } from './agent'
import { createServerCapability, type ServerCapability } from './server'
import { createTunnelCapability, type TunnelCapability } from './tunnel'
import { ensurePiOnHost, piCliPath } from '../ensurePi'
import {
  validatePath as validateScopedPath,
  validatePathStrict as validateScopedPathStrict,
  validatePathForCreation as validateScopedPathForCreation,
  validateCwd as validateScopedCwd,
  addAllowedRoot as addScopedRoot,
  removeAllowedRoot as removeScopedRoot,
  grantFileAccess as grantFile,
  registerScopedWriteAllowance as registerWriteAllowance,
  clearFileGrantsForWindow as clearFileGrants,
  clearScopedWriteAllowancesForWindow as clearWriteAllowances,
  consumeScopedWriteAllowance,
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
  // NO fallback scope: an operation that names no scope is validated against
  // an empty root set (only per-window grants can still admit it), so a caller
  // that omits its workspace scope is rejected instead of being silently
  // widened to the daemon's own root. Callers that legitimately operate at the
  // daemon scope pass config.id explicitly (see extensionsRoot/extractArtifact
  // below, and RemoteRuntime's trusted-caller default on the client side).
  const validatePath = (p: string, ownerWindowId?: number, scopeId?: string) =>
    validateScopedPath(p, ownerWindowId, scopeId)
  const validatePathStrict = (p: string, ownerWindowId?: number, scopeId?: string) =>
    validateScopedPathStrict(p, ownerWindowId, scopeId)
  const validatePathForCreation = (p: string, ownerWindowId?: number, scopeId?: string) =>
    validateScopedPathForCreation(p, ownerWindowId, scopeId)
  const validateCwd = (p: string, ownerWindowId?: number, scopeId?: string) =>
    validateScopedCwd(p, ownerWindowId, scopeId)
  const requireScope = (scopeId?: string): string => {
    if (!scopeId) throw new Error('A path scope is required')
    return scopeId
  }
  const addRoot = (root: string, scopeId?: string) => addScopedRoot(root, requireScope(scopeId))
  const removeRoot = (root: string, scopeId?: string) => removeScopedRoot(root, requireScope(scopeId))

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
    readFile: async (p, access) => fileLeaf.readFile(await validatePathStrict(p, access?.ownerWindowId, access?.scopeId)),
    readBinary: async (p, access) => fileLeaf.readBinary(await validatePathStrict(p, access?.ownerWindowId, access?.scopeId)),
    writeFile: async (p, content, access) => {
      const safePath = await validatePathForCreation(p, access?.ownerWindowId, access?.scopeId)
      await fileLeaf.writeFile(safePath, content)
      if (access?.ownerWindowId != null) consumeScopedWriteAllowance(access.ownerWindowId, safePath)
      return safePath
    },
    writeBinary: async (p, data, access) => {
      const safePath = await validatePathForCreation(p, access?.ownerWindowId, access?.scopeId)
      await fileLeaf.writeBinary(safePath, data)
      if (access?.ownerWindowId != null) consumeScopedWriteAllowance(access.ownerWindowId, safePath)
      return safePath
    },
    readDir: async (p, access) => fileLeaf.readDir(await validatePathStrict(p, access?.ownerWindowId, access?.scopeId), exclusionSet),
    stat: async (p, access) => fileLeaf.statEntry(await validatePathStrict(p, access?.ownerWindowId, access?.scopeId)),
    remove: async (p, access) => fileLeaf.removeEntry(await validatePathStrict(p, access?.ownerWindowId, access?.scopeId)),
    rename: async (oldP, newP, access) => {
      const safeOldPath = await validatePathStrict(oldP, access?.ownerWindowId, access?.scopeId)
      const safeNewPath = await validatePathForCreation(newP, access?.ownerWindowId, access?.scopeId)
      await fileLeaf.renameEntry(safeOldPath, safeNewPath)
      if (access?.ownerWindowId != null) consumeScopedWriteAllowance(access.ownerWindowId, safeNewPath)
      return safeNewPath
    },
    mkdir: async (p, access) => fileLeaf.mkdirEntry(await validatePathForCreation(p, access?.ownerWindowId, access?.scopeId)),
    copy: async (src, destDir, access) =>
      fileLeaf.copyInto(
        await validatePathStrict(src, access?.ownerWindowId, access?.scopeId),
        await validatePathStrict(destDir, access?.ownerWindowId, access?.scopeId),
      ),
    importEntries: async (sources, destDir, mode, access) =>
      fileLeaf.importEntriesInto(
        sources,
        await validatePathStrict(destDir, access?.ownerWindowId, access?.scopeId),
        mode,
        () => { /* errors counted, not logged */ },
      ),
    // Per-host extensions root (~/.cate/extensions). Register it as an allowed
    // root here too (it's also registered at daemon startup) so the very first
    // install on a fresh daemon, or any test driving buildDaemonRuntime directly,
    // can read/write/extract under it. Idempotent. Extension installs are
    // per-host (shared across workspaces), so this root lives at the daemon's
    // own scope — explicitly, since there is no fallback anymore.
    extensionsRoot: async () => {
      const root = hostExtensionsRoot()
      addRoot(root, config.id)
      return root
    },
    // Extract a host-resident, client-verified .tgz into destDir. validatePathStrict
    // on the tgz (it exists), validatePathForCreation on dest (it may not yet) —
    // both must resolve under an allowed root (extensionsRoot above / startup).
    // Provisioning is a per-host concern, hence the explicit daemon scope.
    extractArtifact: async (tgz, destDir) =>
      extractArtifact(
        await validatePathStrict(tgz, undefined, config.id),
        await validatePathForCreation(destDir, undefined, config.id),
      ),
    search: async (root, query, opts, access) =>
      fileLeaf.searchFiles(await validatePathStrict(root, access?.ownerWindowId, access?.scopeId), query, exclusionSet, opts),
    // Content search spawns the ripgrep shipped beside the daemon's node
    // runtime (runtime/bin/rg, sibling of process.execPath = runtime/bin/node).
    // Uses the sync lexical root check, like watch — it returns a handle, not a
    // promise, and the spawn root must be authoritative-validated here.
    searchContent: (root, opts, cbs, access) =>
      runRipgrepSearch(rgPath, opts, validatePath(root, access?.ownerWindowId, access?.scopeId), [...exclusionSet], cbs),
    // watch returns its unsub synchronously and delivers parcel's native
    // create/update/delete to the client (so it can prune removed entries, not
    // just re-read). The root is authoritative-validated here (sync lexical
    // check) before the pool watches it; parcel's `ignore` prunes the daemon's
    // exclusionSet + hidden dirs so the watcher never floods on node_modules/.git.
    watch: (prefix, onChange, access) =>
      watchPool.subscribe(validatePath(prefix, access?.ownerWindowId, access?.scopeId), onChange),
  }

  const env = config.env ?? (() => process.env)
  const cleanEnv = () =>
    Object.fromEntries(Object.entries(env()).filter(([, v]) => v !== undefined)) as Record<string, string>
  // scopeId here is only the fallback for registering discovered worktree
  // roots; every vcs cwd is validated against the CALLER's access.scopeId.
  const vcs = createVcsCapability({ env, scopeId: config.id })

  const innerProc = createProcessCapability({
    resolveShell: (requested) => {
      const resolved = resolveShell(requested)
      const notice = resolved.fallback && requested
        ? `Shell "${requested}" unavailable; using ${resolved.path}\r\n`
        : undefined
      return { path: resolved.path, args: [], notice }
    },
    getEnv: cleanEnv,
    idleSuspend: config.idleSuspend,
  })

  // The daemon is the AUTHORITATIVE cwd check (RemoteRuntime.validateCwd is a
  // client-side pass-through), so validate the terminal cwd here before spawning,
  // matching what terminal.ts does for a local runtime. Throwing rejects create.
  // Terminals are validated at the daemon's own scope (the wire carries no
  // per-workspace scope for pty create; status quo, stated explicitly).
  // Keep it a ProcessCapability (spread carries killAllGroups) so the daemon
  // entry can reap process groups on shutdown.
  const proc: ProcessCapability = {
    ...innerProc,
    create: async (opts, onData, onExit) => {
      if (opts.cwd) validateCwd(opts.cwd, undefined, config.id) // throws -> rejects create, matching local
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
  return {
    runtime,
    process: proc,
    server,
    tunnel,
    killAll: () => { server.killAll(); tunnel.closeAll() },
  }
}
