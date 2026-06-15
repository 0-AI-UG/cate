// =============================================================================
// projectPetStore — per-workspace pet enablement at `<project>/.cate/pet.json`.
//
// Tiny machine-local file recording whether the Canvas Pet was summoned for this
// workspace and whether it's paused, so summon/dismiss/pause survive a restart.
// Mirrors projectTodosStore's load/save contract. Gitignored like the rest of
// .cate/ (only workspace.json is shared).
// =============================================================================

import { ipcMain } from 'electron'
import fs from 'fs/promises'
import path from 'path'
import log from './logger'
import { PROJECT_PET_LOAD, PROJECT_PET_SAVE } from '../shared/ipc-channels'
import type { ProjectPetFile } from '../shared/types'
import { writeJsonAtomic } from './writeJsonAtomic'
import { ensureCateGitignore } from './cateGitignore'
import { isLocalLocator } from './companion/locator'

const CATE_DIR = '.cate'
const PET_FILE = 'pet.json'

const DEFAULTS: ProjectPetFile = { version: 1, enabled: false, paused: false, autoObserve: true }

function cateDir(rootPath: string): string {
  return path.join(rootPath, CATE_DIR)
}

function petPath(rootPath: string): string {
  return path.join(rootPath, CATE_DIR, PET_FILE)
}

export async function loadPetState(rootPath: string): Promise<ProjectPetFile> {
  if (!isLocalLocator(rootPath)) return { ...DEFAULTS }
  try {
    const raw = await fs.readFile(petPath(rootPath), 'utf-8')
    const parsed = JSON.parse(raw) as Partial<ProjectPetFile>
    return {
      version: 1,
      enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : false,
      paused: typeof parsed.paused === 'boolean' ? parsed.paused : false,
      // Absent in older files → default on, preserving the prior always-observe behaviour.
      autoObserve: typeof parsed.autoObserve === 'boolean' ? parsed.autoObserve : true,
    }
  } catch {
    return { ...DEFAULTS }
  }
}

export async function savePetState(rootPath: string, state: ProjectPetFile): Promise<void> {
  if (!isLocalLocator(rootPath)) return
  await ensureCateGitignore(cateDir(rootPath))
  await writeJsonAtomic(petPath(rootPath), {
    version: 1,
    enabled: !!state.enabled,
    paused: !!state.paused,
    autoObserve: state.autoObserve !== false,
  })
}

export function registerProjectPetHandlers(): void {
  ipcMain.handle(PROJECT_PET_LOAD, async (_event, rootPath: string) => loadPetState(rootPath))
  ipcMain.handle(PROJECT_PET_SAVE, async (_event, rootPath: string, state: ProjectPetFile) => {
    try {
      await savePetState(rootPath, state)
    } catch (err) {
      log.warn('[projectPetStore] save failed for %s: %O', cateDir(rootPath), err)
    }
  })
}
