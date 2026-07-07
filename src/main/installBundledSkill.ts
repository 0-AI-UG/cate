// =============================================================================
// installBundledSkill — copy a first-party skill bundled at skills/<name>/ into
// ~/.claude/skills/<name>/ on first launch, where Claude Code discovers it.
//
// Source lives in our tree at skills/<name>/ (committed) and is packaged into
// resources via electron-builder.yml `extraResources`, so we resolve the dev
// path (app.getAppPath()) first and fall back to process.resourcesPath.
//
// Copy-if-missing (fs.cp with force:false) never overwrites a user's edited
// copy — existing files are silently skipped, new ones are added.
// =============================================================================

import fs from 'fs'
import fsp from 'fs/promises'
import os from 'os'
import path from 'path'
import { app } from 'electron'
import log from './logger'

/** Source dir of the bundled skill. Dev path (src/ on disk) first, then the
 *  production extraResources copy. */
function sourceDir(skillName: string): string | null {
  const candidates = [
    path.join(app.getAppPath(), 'skills', skillName),
    path.join(process.resourcesPath ?? '', 'skills', skillName),
  ]
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c
  }
  return null
}

const installed = new Set<string>()

/** Idempotent per skill. Call once at app-ready. */
export async function installBundledSkill(skillName: string): Promise<void> {
  if (installed.has(skillName)) return
  installed.add(skillName)
  try {
    const src = sourceDir(skillName)
    if (!src) {
      log.warn('[installBundledSkill] source dir not found — %s skill not installed', skillName)
      return
    }
    const dest = path.join(os.homedir(), '.claude', 'skills', skillName)
    await fsp.cp(src, dest, { recursive: true, force: false, errorOnExist: false })
    log.info('[installBundledSkill] installed %s', dest)
  } catch (err) {
    log.warn('[installBundledSkill] install of %s failed: %O', skillName, err)
  }
}
