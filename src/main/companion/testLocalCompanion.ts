// =============================================================================
// Test-only in-process LOCAL companion. In production the LOCAL workspace runs as
// the companion daemon subprocess (provisioned by ensureLocalCompanion), so the
// fs/git IPC handlers resolve LOCAL only after that connects. Unit tests that
// drive those handlers directly (no daemon) register this lightweight stand-in,
// whose file/vcs ops are the same electron-free leaf functions + the live
// project-exclusion wrappers in filesystem.ts — matching what the old in-process
// LocalCompanion did. NOT shipped in the app.
// =============================================================================

import { LOCAL_COMPANION_ID } from './locator'
import type { Companion, FileHost } from './types'
import {
  readFile,
  readBinary,
  writeFile,
  writeBinary,
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
  addAllowedRoot as addRoot,
  removeAllowedRoot as removeRoot,
  grantFileAccess as grantFile,
  registerScopedWriteAllowance as registerWriteAllowance,
} from '../ipc/pathValidation'
import { createVcsCapability } from '../../companion/capabilities/vcs'
import { getShellEnv } from '../shellEnv'
import { companions } from './companionManager'

function buildLocalFileHost(): FileHost {
  return {
    readFile: (p) => readFile(p),
    readBinary: (p) => readBinary(p),
    writeFile: (p, content) => writeFile(p, content),
    writeBinary: (p, data) => writeBinary(p, data),
    readDir: (p) => readDir(p),
    stat: (p) => statEntry(p),
    remove: (p) => removeEntry(p),
    rename: (oldP, newP) => renameEntry(oldP, newP),
    mkdir: (p) => mkdirEntry(p),
    copy: (src, destDir) => copyInto(src, destDir),
    importEntries: (sources, destDir, mode, winId) => importEntriesInto(sources, destDir, mode, winId),
    search: (root, query, opts) => searchFiles(root, query, opts),
    // Content search isn't exercised by the handler tests that use this stand-in;
    // they call the daemon api in the loopback test instead.
    searchContent: () => { throw new Error('searchContent not supported by the test local companion') },
    watch: (prefix, onChange) => subscribeFsChanges(prefix, onChange),
  }
}

/** An in-process Companion under LOCAL_COMPANION_ID, equivalent to the former
 *  in-process LocalCompanion (file ops read the live exclusion set). */
export function makeTestLocalCompanion(): Companion {
  return {
    id: LOCAL_COMPANION_ID,
    process: {} as unknown as Companion['process'],
    agent: {} as unknown as Companion['agent'],
    file: buildLocalFileHost(),
    vcs: createVcsCapability({ env: getShellEnv }),
    validatePath: (p, winId) => validatePath(p, winId),
    validatePathStrict: (p, winId) => validatePathStrict(p, winId),
    validatePathForCreation: (p, winId) => validatePathForCreation(p, winId),
    validateCwd: (cwd, winId) => validateCwd(cwd, winId),
    addAllowedRoot: async (root) => { addRoot(root) },
    removeAllowedRoot: async (root) => { removeRoot(root) },
    setExclusions: async () => {},
    setIdleSuspend: async () => {},
    grantFileAccess: async (filePath, ownerWindowId) => { await grantFile(ownerWindowId, filePath) },
    registerScopedWriteAllowance: async (safePath, ownerWindowId) => { await registerWriteAllowance(ownerWindowId, safePath) },
    clearFileGrantsForWindow: async () => {},
    clearScopedWriteAllowancesForWindow: async () => {},
  }
}

/** Register the in-process LOCAL companion so handler tests can resolve it. */
export function registerTestLocalCompanion(): Companion {
  const companion = makeTestLocalCompanion()
  companions.registerLocalForTest(companion)
  return companion
}
