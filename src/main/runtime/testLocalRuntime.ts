// =============================================================================
// Test-only in-process LOCAL runtime. In production the LOCAL workspace runs as
// the runtime daemon subprocess (provisioned by ensureLocalRuntime), so the
// fs/git IPC handlers resolve LOCAL only after that connects. Unit tests that
// drive those handlers directly (no daemon) register this lightweight stand-in,
// whose file/vcs ops are the same electron-free leaf functions + the live
// project-exclusion wrappers in filesystem.ts — matching what the old in-process
// LocalRuntime did. NOT shipped in the app.
// =============================================================================

import { LOCAL_RUNTIME_ID } from './locator'
import type { Runtime, FileHost } from './types'
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
import { hostExtensionsRoot, extractArtifact } from '../../runtime/capabilities/extensions'
import { createVcsCapability } from '../../runtime/capabilities/vcs'
import { createServerCapability } from '../../runtime/capabilities/server'
import { createTunnelCapability } from '../../runtime/capabilities/tunnel'
import { getShellEnv } from '../shellEnv'
import { runtimes } from './runtimeManager'

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
    extensionsRoot: async () => { const root = hostExtensionsRoot(); addRoot(root); return root },
    extractArtifact: async (tgz, destDir) => extractArtifact(await validatePathStrict(tgz), await validatePathForCreation(destDir)),
    search: (root, query, opts) => searchFiles(root, query, opts),
    // Content search isn't exercised by the handler tests that use this stand-in;
    // they call the daemon api in the loopback test instead.
    searchContent: () => { throw new Error('searchContent not supported by the test local runtime') },
    watch: (prefix, onChange) => subscribeFsChanges(prefix, onChange),
  }
}

/** An in-process Runtime under LOCAL_RUNTIME_ID, equivalent to the former
 *  in-process LocalRuntime (file ops read the live exclusion set). */
export function makeTestLocalRuntime(): Runtime {
  return {
    id: LOCAL_RUNTIME_ID,
    process: {} as unknown as Runtime['process'],
    agent: {} as unknown as Runtime['agent'],
    file: buildLocalFileHost(),
    vcs: createVcsCapability({ env: getShellEnv }),
    // Real electron-free capabilities — exercised by the loopback tests.
    server: createServerCapability({ baseEnv: getShellEnv }),
    tunnel: createTunnelCapability(),
    validatePath: (p, winId, scopeId) => validatePath(p, winId, scopeId),
    validatePathStrict: (p, winId, scopeId) => validatePathStrict(p, winId, scopeId),
    validatePathForCreation: (p, winId, scopeId) => validatePathForCreation(p, winId, scopeId),
    validateCwd: (cwd, winId, scopeId) => validateCwd(cwd, winId, scopeId),
    addAllowedRoot: async (root, scopeId) => { addRoot(root, scopeId) },
    removeAllowedRoot: async (root, scopeId) => { removeRoot(root, scopeId) },
    setExclusions: async () => {},
    setIdleSuspend: async () => {},
    grantFileAccess: async (filePath, ownerWindowId) => { await grantFile(ownerWindowId, filePath) },
    registerScopedWriteAllowance: async (safePath, ownerWindowId) => { await registerWriteAllowance(ownerWindowId, safePath) },
    clearFileGrantsForWindow: async () => {},
    clearScopedWriteAllowancesForWindow: async () => {},
  }
}

/** Register the in-process LOCAL runtime so handler tests can resolve it. */
export function registerTestLocalRuntime(): Runtime {
  const runtime = makeTestLocalRuntime()
  runtimes.registerLocalForTest(runtime)
  return runtime
}
