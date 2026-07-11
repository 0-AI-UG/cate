// =============================================================================
// projectCateAgentStore — per-workspace Cate Agent preferences at
// `<project>/.cate/cateAgent.json`.
//
// Tiny per-workspace file recording whether automatic observations are on for
// this workspace (the Cate Agent itself is always on), so the choice survives a
// restart. Local roots write directly; remote roots write the same file through
// the runtime, so the preference behaves identically wherever the workspace
// lives. Mirrors projectChatsStore's load/save contract. Gitignored like the
// rest of .cate/ (only workspace.json is shared).
// =============================================================================

import { ipcMain } from 'electron'
import fs from 'fs/promises'
import path from 'path'
import log from './logger'
import { PROJECT_CATE_AGENT_LOAD, PROJECT_CATE_AGENT_SAVE } from '../shared/ipc-channels'
import type { ProjectCateAgentFile } from '../shared/types'
import { writeJsonAtomic } from './writeJsonAtomic'
import { quarantineCorruptFile } from './quarantineCorruptFile'
import { isPlainObject } from './jsonUtils'
import { ensureCateGitignore, CATE_GITIGNORE_CONTENT } from './cateGitignore'
import { isLocalLocator, parseLocator } from './runtime/locator'
import { runtimes } from './runtime/runtimeManager'

const CATE_DIR = '.cate'
const CATE_AGENT_FILE = 'cateAgent.json'

const DEFAULTS: ProjectCateAgentFile = { version: 1, autoObserve: true }

function cateDir(rootPath: string): string {
  return path.join(rootPath, CATE_DIR)
}

function cateAgentPath(rootPath: string): string {
  return path.join(rootPath, CATE_DIR, CATE_AGENT_FILE)
}

/** Per-field normalize: the file is hand-editable, so a missing or non-boolean
 *  flag degrades to the default without rejecting the file. */
function normalizeCateAgentFile(parsed: unknown): ProjectCateAgentFile {
  const o = isPlainObject(parsed) ? parsed : {}
  return {
    version: 1,
    autoObserve: typeof o.autoObserve === 'boolean' ? o.autoObserve : DEFAULTS.autoObserve,
  }
}

// Remote workspaces persist the same `.cate/cateAgent.json` through the
// runtime (remote paths are POSIX; runtime.file.writeFile is atomic tmp+rename
// on the host, matching writeJsonAtomic locally). Corrupt files aren't
// quarantined over RPC — a corrupt remote file just degrades to defaults, same
// posture as projectWorkspaceStore's remote branch.
function remoteTargets(rootPath: string) {
  const { runtimeId, path: base } = parseLocator(rootPath)
  const dir = path.posix.join(base, CATE_DIR)
  return {
    runtime: runtimes.resolve(runtimeId),
    file: path.posix.join(dir, CATE_AGENT_FILE),
    gitignoreFile: path.posix.join(dir, '.gitignore'),
  }
}

async function loadCateAgentStateRemote(rootPath: string): Promise<ProjectCateAgentFile> {
  const { runtime, file } = remoteTargets(rootPath)
  const raw = await runtime.file.readFile(file).catch(() => null)
  if (!raw) return { ...DEFAULTS } // absent (or runtime hiccup) — defaults
  try {
    return normalizeCateAgentFile(JSON.parse(raw))
  } catch {
    log.warn('[projectCateAgentStore] corrupt remote %s; using defaults', file)
    return { ...DEFAULTS }
  }
}

async function saveCateAgentStateRemote(rootPath: string, state: ProjectCateAgentFile): Promise<void> {
  const { runtime, file, gitignoreFile } = remoteTargets(rootPath)
  // Write-once .gitignore, mirroring ensureCateGitignore on the local branch.
  await runtime.file
    .stat(gitignoreFile)
    .catch(() => runtime.file.writeFile(gitignoreFile, CATE_GITIGNORE_CONTENT))
  await runtime.file.writeFile(file, `${JSON.stringify({ version: 1, autoObserve: state.autoObserve !== false }, null, 2)}\n`)
}

export async function loadCateAgentState(rootPath: string): Promise<ProjectCateAgentFile> {
  if (!isLocalLocator(rootPath)) return loadCateAgentStateRemote(rootPath)
  let raw: string
  try {
    raw = await fs.readFile(cateAgentPath(rootPath), 'utf-8')
  } catch {
    return { ...DEFAULTS } // absent — this workspace has no saved preference yet
  }
  try {
    return normalizeCateAgentFile(JSON.parse(raw))
  } catch {
    // Unparseable (bad hand-edit / crash mid-write): quarantine the broken file
    // so it survives for recovery instead of being silently overwritten by the
    // next save — the same posture jsonStateFile applies to userData files.
    const backup = quarantineCorruptFile(cateAgentPath(rootPath))
    log.warn('[projectCateAgentStore] corrupt %s%s; using defaults', cateAgentPath(rootPath), backup ? `, backed up to ${backup}` : '')
    return { ...DEFAULTS }
  }
}

export async function saveCateAgentState(rootPath: string, state: ProjectCateAgentFile): Promise<void> {
  if (!isLocalLocator(rootPath)) return saveCateAgentStateRemote(rootPath, state)
  await ensureCateGitignore(cateDir(rootPath))
  await writeJsonAtomic(cateAgentPath(rootPath), {
    version: 1,
    autoObserve: state.autoObserve !== false,
  })
}

export function registerProjectCateAgentHandlers(): void {
  ipcMain.handle(PROJECT_CATE_AGENT_LOAD, async (_event, rootPath: string) => loadCateAgentState(rootPath))
  ipcMain.handle(PROJECT_CATE_AGENT_SAVE, async (_event, rootPath: string, state: ProjectCateAgentFile) => {
    try {
      await saveCateAgentState(rootPath, state)
    } catch (err) {
      log.warn('[projectCateAgentStore] save failed for %s: %O', cateDir(rootPath), err)
    }
  })
}
