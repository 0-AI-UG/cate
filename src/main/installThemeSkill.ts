// =============================================================================
// installThemeSkill — copy the bundled cate-theme authoring skill into
// ~/.claude/skills/cate-theme/ on first launch, where Claude Code discovers it.
//
// Source lives in our tree at skills/cate-theme/ (committed). It is packaged
// into resources via electron-builder.yml `extraResources`, so we resolve the
// dev path (app.getAppPath()) first and fall back to process.resourcesPath.
//
// Skip-if-exists: never overwrite a user's modified copy.
// =============================================================================

import fs from 'fs'
import fsp from 'fs/promises'
import os from 'os'
import path from 'path'
import { app } from 'electron'
import log from './logger'

/** Source dir of the bundled skill. Dev path (src/ on disk) first, then the
 *  production extraResources copy. */
function sourceDir(): string | null {
  const candidates = [
    path.join(app.getAppPath(), 'skills', 'cate-theme'),
    path.join(process.resourcesPath ?? '', 'skills', 'cate-theme'),
  ]
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c
  }
  return null
}

async function copyIfMissing(src: string, dest: string): Promise<void> {
  try {
    await fsp.access(dest)
    return // already present — keep user edits
  } catch { /* fall through */ }
  await fsp.mkdir(path.dirname(dest), { recursive: true })
  await fsp.copyFile(src, dest)
  log.info('[installThemeSkill] installed %s', dest)
}

let installed = false

/** Idempotent. Call once at app-ready. */
export async function installThemeSkill(): Promise<void> {
  if (installed) return
  installed = true
  try {
    const src = sourceDir()
    if (!src) {
      log.warn('[installThemeSkill] source dir not found — cate-theme skill not installed')
      return
    }
    const destDir = path.join(os.homedir(), '.claude', 'skills', 'cate-theme')
    await copyIfMissing(path.join(src, 'SKILL.md'), path.join(destDir, 'SKILL.md'))
    await copyIfMissing(path.join(src, 'theme.schema.json'), path.join(destDir, 'theme.schema.json'))

    // Examples — copy every *.json bundled under examples/.
    const examplesSrc = path.join(src, 'examples')
    if (fs.existsSync(examplesSrc)) {
      for (const name of await fsp.readdir(examplesSrc)) {
        if (name.endsWith('.json')) {
          await copyIfMissing(path.join(examplesSrc, name), path.join(destDir, 'examples', name))
        }
      }
    }
  } catch (err) {
    log.warn('[installThemeSkill] install failed: %O', err)
  }
}
