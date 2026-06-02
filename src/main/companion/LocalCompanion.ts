// =============================================================================
// LocalCompanion — the in-process backend for the local machine. It is a thin
// adapter: every method forwards to the existing main-process functions, so the
// local code path is byte-for-byte what it was before the companion seam. This
// is the Phase 1 de-risking step — no behavior change, the full test suite must
// stay green with zero test edits.
//
// Phase 1 implements `file` + `vcs` + `validate*`. `process` (terminals) joins
// in Phase 3 alongside the streaming relocation.
// =============================================================================

import { LOCAL_COMPANION_ID } from './locator'
import type { Companion, FileHost } from './types'
import { localProcessHost } from './localProcessHost'
import { localAgentHost } from './localAgentHost'
import {
  readFile,
  readBinary,
  writeFile,
  readDir,
  statEntry,
  removeEntry,
  renameEntry,
  mkdirEntry,
  copyInto,
  importEntriesInto,
  searchFiles,
  subscribeFsChanges,
} from '../ipc/filesystem'
import {
  validatePath,
  validatePathStrict,
  validatePathForCreation,
  validateCwd,
} from '../ipc/pathValidation'
import { createVcsCapability } from '../../companion/capabilities/vcs'
import { getShellEnv } from '../shellEnv'

// Methods are written as arrows that delegate at call time so circular imports
// (filesystem.ts / git.ts both import the companion registry) never capture a
// stale binding.

const localFile: FileHost = {
  readFile: (p) => readFile(p),
  readBinary: (p) => readBinary(p),
  writeFile: (p, content) => writeFile(p, content),
  readDir: (p) => readDir(p),
  stat: (p) => statEntry(p),
  remove: (p) => removeEntry(p),
  rename: (oldP, newP) => renameEntry(oldP, newP),
  mkdir: (p) => mkdirEntry(p),
  copy: (src, destDir) => copyInto(src, destDir),
  importEntries: (sources, destDir, mode, winId) => importEntriesInto(sources, destDir, mode, winId),
  search: (root, query, opts) => searchFiles(root, query, opts),
  watch: (prefix, onChange) => subscribeFsChanges(prefix, onChange),
}

// The single git implementation, wired with the resolved login-shell env so
// `git`/`gh` get the full PATH (Homebrew, etc.) the GUI process otherwise
// misses — matching how localProcessHost spawns shells. The daemon builds the
// same capability with process.env.
const localVcs = createVcsCapability({ env: getShellEnv })

export const localCompanion: Companion = {
  id: LOCAL_COMPANION_ID,
  process: localProcessHost,
  agent: localAgentHost,
  file: localFile,
  vcs: localVcs,
  validatePath: (p, winId) => validatePath(p, winId),
  validatePathStrict: (p, winId) => validatePathStrict(p, winId),
  validatePathForCreation: (p, winId) => validatePathForCreation(p, winId),
  validateCwd: (cwd, winId) => validateCwd(cwd, winId),
}
