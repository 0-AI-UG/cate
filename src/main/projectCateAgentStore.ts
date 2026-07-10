// =============================================================================
// projectCateAgentStore — per-workspace Cate Agent preferences at
// `<project>/.cate/cateAgent.json`.
//
// Tiny machine-local file recording whether automatic observations are on for
// this workspace (the Cate Agent itself is always on), so the choice survives a
// restart. Mirrors projectChatsStore's load/save contract. Gitignored like the
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
import { ensureCateGitignore } from './cateGitignore'
import { isLocalLocator } from './runtime/locator'

const CATE_DIR = '.cate'
const CATE_AGENT_FILE = 'cateAgent.json'

const DEFAULTS: ProjectCateAgentFile = { version: 1, autoObserve: true }

function cateDir(rootPath: string): string {
  return path.join(rootPath, CATE_DIR)
}

function cateAgentPath(rootPath: string): string {
  return path.join(rootPath, CATE_DIR, CATE_AGENT_FILE)
}

export async function loadCateAgentState(rootPath: string): Promise<ProjectCateAgentFile> {
  if (!isLocalLocator(rootPath)) return { ...DEFAULTS }
  let raw: string
  try {
    raw = await fs.readFile(cateAgentPath(rootPath), 'utf-8')
  } catch {
    return { ...DEFAULTS } // absent — this workspace has no saved preference yet
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // Unparseable (bad hand-edit / crash mid-write): quarantine the broken file
    // so it survives for recovery instead of being silently overwritten by the
    // next save — the same posture jsonStateFile applies to userData files.
    const backup = quarantineCorruptFile(cateAgentPath(rootPath))
    log.warn('[projectCateAgentStore] corrupt %s%s; using defaults', cateAgentPath(rootPath), backup ? `, backed up to ${backup}` : '')
    return { ...DEFAULTS }
  }
  const o = isPlainObject(parsed) ? parsed : {}
  return {
    version: 1,
    // Per-field normalize: the file is hand-editable, so a missing or
    // non-boolean flag degrades to the default without rejecting the file.
    autoObserve: typeof o.autoObserve === 'boolean' ? o.autoObserve : DEFAULTS.autoObserve,
  }
}

export async function saveCateAgentState(rootPath: string, state: ProjectCateAgentFile): Promise<void> {
  if (!isLocalLocator(rootPath)) return
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
