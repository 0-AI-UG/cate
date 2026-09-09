// Starred-library bytes live in app userData. Workspace installs are tracked
// separately; saving to this cache never installs into any workspace.
import { createHash } from 'node:crypto'
import { app } from 'electron'
import fs from 'fs/promises'
import path from 'path'
import type { SkillFile } from './githubCrawl'
import { retireBundle, prepareBundle, readDirectory, replaceBundle, skillFiles } from './skillBundle'
import { localSkillFiles } from './localSkillFiles'
import { withSkillWorkspaces } from './skillWorkspace'

function storeRoot(): string {
  return path.join(app.getPath('userData'), 'skills-store')
}

function keyFor(skillId: string): string {
  return createHash('sha256').update(skillId).digest('hex')
}

function skillDir(skillId: string): string {
  return path.join(storeRoot(), keyFor(skillId))
}

function legacyKey(skillId: string): string {
  return skillId.replace(/[^a-zA-Z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '') || 'skill'
}
async function migrateLegacy(skillId: string): Promise<void> {
  const destination = skillDir(skillId)
  try { await fs.access(destination); return } catch { /* check legacy owner */ }
  const legacy = path.join(storeRoot(), legacyKey(skillId))
  try { await fs.access(path.join(legacy, 'SKILL.md')) } catch { return }
  const { listSaved } = await import('./savedSkills')
  const owners = listSaved().filter(row => legacyKey(row.skillId) === legacyKey(skillId))
  // Ambiguous legacy directories cannot be attributed safely to either ID.
  if (owners.length !== 1 || owners[0].skillId !== skillId) return
  await withSkillWorkspaces([legacy, destination], async () => {
    try { await fs.access(destination); return } catch { /* not migrated */ }
    await fs.rename(legacy, destination)
  })
}

export async function has(skillId: string): Promise<boolean> {
  await migrateLegacy(skillId)
  try {
    await fs.access(path.join(skillDir(skillId), 'SKILL.md'))
    return true
  } catch {
    return false
  }
}

/** Read a cached saved skill's files; null if not cached. */
export async function read(skillId: string): Promise<SkillFile[] | null> {
  if (!(await has(skillId))) return null
  const files = skillFiles(await readDirectory(localSkillFiles, 'local', skillDir(skillId)))
  return files.length ? files : null
}

/** Cache a skill's files (used when saving a skill to the library). */
export async function cache(skillId: string, files: SkillFile[]): Promise<void> {
  const prepared = prepareBundle(files)
  await migrateLegacy(skillId)
  const dir = skillDir(skillId)
  await withSkillWorkspaces([dir], async () => {
    await fs.mkdir(storeRoot(), { recursive: true })
    let exists = false
    try { await fs.stat(dir); exists = true } catch { /* first cache */ }
    await replaceBundle(localSkillFiles, 'local', storeRoot(), dir, prepared, 'folder', exists, storeRoot())
  })
}

/** Drop a cached skill (used when removing it from the library). */
export async function remove(skillId: string): Promise<void> {
  await migrateLegacy(skillId)
  await withSkillWorkspaces([skillDir(skillId)], () => retireBundle(localSkillFiles, 'local', storeRoot(), skillDir(skillId)))
}
