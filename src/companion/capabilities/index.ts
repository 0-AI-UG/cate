// =============================================================================
// buildDaemonCompanion — assembles a Companion from the electron-free file +
// vcs capabilities, for the standalone daemon to host. The same FileHost/VcsHost
// the local process uses, wired with the daemon's configured exclusion set and
// process.env. Validation uses the electron-free pathValidation module; the
// daemon registers its workspace root via addAllowedRoot at startup.
// =============================================================================

import { watch } from 'chokidar'
import { existsSync } from 'fs'
import * as fileLeaf from './file'
import { createVcsCapability } from './vcs'
import { createProcessCapability } from './process'
import { createAgentCapability } from './agent'
import { ensurePiOnHost, piCliPath } from '../ensurePi'
import {
  validatePath,
  validatePathStrict,
  validatePathForCreation,
  validateCwd,
} from '../../main/ipc/pathValidation'
import type { Companion, FileHost } from '../../main/companion/types'

export interface DaemonCompanionConfig {
  id: string
  /** Basenames to hide in readDir/search (the daemon's mirror of fileExclusions). */
  exclusions?: string[]
  /** Env for git/gh subprocesses. Defaults to process.env. */
  env?: () => NodeJS.ProcessEnv
}

export function buildDaemonCompanion(config: DaemonCompanionConfig): Companion {
  const exclusionSet = new Set(config.exclusions ?? [])

  const file: FileHost = {
    readFile: fileLeaf.readFile,
    readBinary: fileLeaf.readBinary,
    writeFile: fileLeaf.writeFile,
    readDir: (p) => fileLeaf.readDir(p, exclusionSet),
    stat: fileLeaf.statEntry,
    remove: fileLeaf.removeEntry,
    rename: fileLeaf.renameEntry,
    mkdir: fileLeaf.mkdirEntry,
    copy: fileLeaf.copyInto,
    importEntries: (sources, destDir, mode, winId) =>
      fileLeaf.importEntriesInto(sources, destDir, mode, winId, () => { /* errors counted, not logged */ }),
    search: (root, query, opts) => fileLeaf.searchFiles(root, query, exclusionSet, opts),
    watch: (prefix, onChange) => {
      const w = watch(prefix, { ignoreInitial: true })
      const fire = (fp: string) => onChange(fp)
      w.on('add', fire)
      w.on('change', fire)
      w.on('unlink', fire)
      return () => { void w.close() }
    },
  }

  const env = config.env ?? (() => process.env)
  const vcs = createVcsCapability({ env })

  // Daemon shell resolution: first existing of [requested, $SHELL, bash, sh].
  // Verifying existence avoids an execvp ENOENT (e.g. a stale $SHELL, or a shell
  // path forwarded from a different-OS client) — we fall back with a notice.
  const proc = createProcessCapability({
    resolveShell: (requested) => {
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
  })

  // Agent: the daemon pulls the pi tarball to the host and runs it under the
  // bundled node (process.execPath == the companion's runtime node here).
  const agent = createAgentCapability({
    ensurePi: ensurePiOnHost,
    piCliPath,
    nodeBin: () => process.execPath,
    baseEnv: () => Object.fromEntries(Object.entries(env()).filter(([, v]) => v !== undefined)) as Record<string, string>,
  })

  return {
    id: config.id,
    process: proc,
    agent,
    file,
    vcs,
    validatePath,
    validatePathStrict,
    validatePathForCreation,
    validateCwd,
  }
}
