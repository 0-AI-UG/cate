// =============================================================================
// Global skill cache — Cate's userData copy of GLOBAL skills only.
//
// Workspace installs are NOT cached (they fetch from GitHub, or copy from an
// existing local install of the same skill). Only skills promoted to "global"
// are cached here, so reconcile can replay them into every workspace on open
// without a network round-trip. Keyed by skillId.
// =============================================================================

import { app } from 'electron'
import fs from 'fs/promises'
import path from 'path'
import type { SkillFile } from './githubCrawl'

function storeRoot(): string {
  return path.join(app.getPath('userData'), 'skills-store')
}

function keyFor(skillId: string): string {
  return skillId.replace(/[^a-zA-Z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '') || 'skill'
}

function skillDir(skillId: string): string {
  return path.join(storeRoot(), keyFor(skillId))
}

async function walk(dir: string, base = ''): Promise<SkillFile[]> {
  const out: SkillFile[] = []
  let entries: import('fs').Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const abs = path.join(dir, e.name)
    const rel = base ? `${base}/${e.name}` : e.name
    if (e.isDirectory()) {
      out.push(...(await walk(abs, rel)))
    } else if (e.isFile()) {
      const buf = await fs.readFile(abs)
      const text = buf.toString('utf-8')
      if (!text.includes('�')) out.push({ relPath: rel, text })
      else out.push({ relPath: rel, base64: buf.toString('base64') })
    }
  }
  return out
}

export async function has(skillId: string): Promise<boolean> {
  try {
    await fs.access(path.join(skillDir(skillId), 'SKILL.md'))
    return true
  } catch {
    return false
  }
}

/** Read a cached global skill's files; null if not cached. */
export async function read(skillId: string): Promise<SkillFile[] | null> {
  if (!(await has(skillId))) return null
  const files = await walk(skillDir(skillId))
  return files.length ? files : null
}

/** Cache a skill's files (used when promoting a skill to global). */
export async function cache(skillId: string, files: SkillFile[]): Promise<void> {
  const dir = skillDir(skillId)
  await fs.rm(dir, { recursive: true, force: true })
  await fs.mkdir(dir, { recursive: true })
  for (const f of files) {
    const abs = path.join(dir, ...f.relPath.split('/'))
    await fs.mkdir(path.dirname(abs), { recursive: true })
    if (f.text != null) await fs.writeFile(abs, f.text, 'utf-8')
    else if (f.base64 != null) await fs.writeFile(abs, Buffer.from(f.base64, 'base64'))
  }
}

/** Drop a cached skill (used when demoting from global). */
export async function remove(skillId: string): Promise<void> {
  await fs.rm(skillDir(skillId), { recursive: true, force: true })
}
