// =============================================================================
// projectCateAgentStore — per-workspace Cate Agent enablement at `<project>/.cate/cateAgent.json`.
//
// Tiny machine-local file recording whether the Cate Agent was summoned for this
// workspace, so summon/dismiss survive a restart. Mirrors projectTodosStore's
// load/save contract. Gitignored like the rest of .cate/ (only workspace.json is
// shared).
// =============================================================================

import { ipcMain } from 'electron'
import fs from 'fs/promises'
import path from 'path'
import log from './logger'
import { PROJECT_CATE_AGENT_LOAD, PROJECT_CATE_AGENT_SAVE } from '../shared/ipc-channels'
import type { ProjectCateAgentFile } from '../shared/types'
import { writeJsonAtomic } from './writeJsonAtomic'
import { ensureCateGitignore } from './cateGitignore'
import { isLocalLocator } from './companion/locator'

const CATE_DIR = '.cate'
const CATE_AGENT_FILE = 'cateAgent.json'

const DEFAULTS: ProjectCateAgentFile = { version: 1, enabled: false, autoObserve: true }

function cateDir(rootPath: string): string {
  return path.join(rootPath, CATE_DIR)
}

function cateAgentPath(rootPath: string): string {
  return path.join(rootPath, CATE_DIR, CATE_AGENT_FILE)
}

export async function loadCateAgentState(rootPath: string): Promise<ProjectCateAgentFile> {
  if (!isLocalLocator(rootPath)) return { ...DEFAULTS }
  try {
    const raw = await fs.readFile(cateAgentPath(rootPath), 'utf-8')
    const parsed = JSON.parse(raw) as Partial<ProjectCateAgentFile>
    return {
      version: 1,
      enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : false,
      // Absent in older files → default on, preserving the prior always-observe behaviour.
      autoObserve: typeof parsed.autoObserve === 'boolean' ? parsed.autoObserve : true,
    }
  } catch {
    return { ...DEFAULTS }
  }
}

export async function saveCateAgentState(rootPath: string, state: ProjectCateAgentFile): Promise<void> {
  if (!isLocalLocator(rootPath)) return
  await ensureCateGitignore(cateDir(rootPath))
  await writeJsonAtomic(cateAgentPath(rootPath), {
    version: 1,
    enabled: !!state.enabled,
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
