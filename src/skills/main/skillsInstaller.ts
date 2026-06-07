// =============================================================================
// Skill install engine — writes a skill into a workspace's per-target dir via
// the companion (local AND remote), and tracks installs in <ws>/.cate/skills.json.
//
// Resolving a skill's files for a workspace install, in order:
//   - reuse an existing install of the same skill in ANOTHER agent here (copy
//     agent → agent);
//   - reuse the saved-library cache (skillStore), if the skill was saved;
//   - otherwise fetch from GitHub.
// Saving (saveSkill) caches the bytes in skillStore + records the skill in the
// userData library; it never touches a workspace.
// =============================================================================

import log from '../../main/logger'
import { parseLocator, formatLocator } from '../../main/companion/locator'
import { companions } from '../../main/companion/companionManager'
import { hostJoin } from '../../agent/main/agentDir'
import type { Companion } from '../../main/companion/types'
import { skillsRootDir, targetInfo } from './targets'
import { ensureSkillName } from './frontmatter'
import * as skillStore from './skillStore'
import * as savedSkills from './savedSkills'
import { getToken } from './skillSources'
import { slugifySkillName, type InstalledSkill, type SkillEntry, type SkillTargetId } from '../../shared/skills'
import { fetchSkillFiles, type SkillFile } from './githubCrawl'

// ---------------------------------------------------------------------------
// Manifest (<workspace>/.cate/skills.json)
// ---------------------------------------------------------------------------

interface SkillsManifest {
  skills: InstalledSkill[]
}

function manifestPath(companionId: string, hostCwd: string): string {
  return hostJoin(companionId, hostCwd, '.cate', 'skills.json')
}

export async function readManifest(companion: Companion, companionId: string, hostCwd: string): Promise<InstalledSkill[]> {
  try {
    const raw = await companion.file.readFile(manifestPath(companionId, hostCwd))
    const parsed = JSON.parse(raw) as SkillsManifest
    return Array.isArray(parsed.skills) ? parsed.skills : []
  } catch {
    return []
  }
}

async function writeManifest(companion: Companion, companionId: string, hostCwd: string, skills: InstalledSkill[]): Promise<void> {
  await companion.file.mkdir(hostJoin(companionId, hostCwd, '.cate'))
  const manifest: SkillsManifest = { skills }
  await companion.file.writeFile(manifestPath(companionId, hostCwd), `${JSON.stringify(manifest, null, 2)}\n`)
}

// ---------------------------------------------------------------------------
// Write a skill into a workspace
// ---------------------------------------------------------------------------

export interface WriteSkillArgs {
  skillId: string
  name: string
  targetId: SkillTargetId
  cwd: string
  files: SkillFile[]
  origin: 'local'
}

export interface WriteSkillResult {
  installed: InstalledSkill
  warnings: string[]
}

/** Create every directory level from the (existing) workspace root down to
 *  `targetDir`. `companion.file.mkdir` is recursive but its validation requires
 *  the IMMEDIATE parent to already exist, so we walk level by level — e.g. a
 *  fresh `.codex/skills` works even though `.codex` didn't exist yet. */
async function mkdirp(companion: Companion, companionId: string, hostCwd: string, targetDir: string): Promise<void> {
  if (!targetDir.startsWith(hostCwd)) {
    await companion.file.mkdir(targetDir)
    return
  }
  const rel = targetDir.slice(hostCwd.length).replace(/^[/\\]+/, '')
  let cur = hostCwd
  for (const part of rel.split(/[/\\]+/).filter(Boolean)) {
    cur = hostJoin(companionId, cur, part)
    await companion.file.mkdir(cur)
  }
}

async function writeFile(companion: Companion, hostPath: string, file: SkillFile, slug: string): Promise<void> {
  if (file.text != null) {
    const content = file.relPath === 'SKILL.md' ? ensureSkillName(file.text, slug) : file.text
    await companion.file.writeFile(hostPath, content)
  } else if (file.base64 != null) {
    await companion.file.writeBinary(hostPath, Buffer.from(file.base64, 'base64'))
  }
}

export async function writeSkillToWorkspace(args: WriteSkillArgs): Promise<WriteSkillResult> {
  const { skillId, name, targetId, cwd, files, origin } = args
  const { companionId, path: hostCwd } = parseLocator(cwd)
  if (!hostCwd) throw new Error('Workspace has no folder open')
  const companion = companions.resolve(companionId)
  const info = targetInfo(targetId)
  const slug = slugifySkillName(name)
  const root = skillsRootDir(targetId, companionId, hostCwd)

  const warnings: string[] = []
  let installedHostPath: string

  if (info.layout === 'folder') {
    const dir = hostJoin(companionId, root, slug)
    await mkdirp(companion, companionId, hostCwd, dir)
    for (const f of files) {
      const segs = f.relPath.split('/')
      const target = hostJoin(companionId, dir, ...segs)
      if (segs.length > 1) {
        await mkdirp(companion, companionId, hostCwd, hostJoin(companionId, dir, ...segs.slice(0, -1)))
      }
      await writeFile(companion, target, f, slug)
    }
    installedHostPath = hostJoin(companionId, dir, 'SKILL.md')
  } else {
    const skillMd = files.find((f) => f.relPath === 'SKILL.md')
    if (!skillMd?.text) throw new Error('Skill is missing SKILL.md')
    const extras = files.filter((f) => f.relPath !== 'SKILL.md')
    if (extras.length) {
      warnings.push(`${info.label} supports single-file skills only; ${extras.length} bundled file(s) were not installed.`)
    }
    await mkdirp(companion, companionId, hostCwd, root)
    const file = hostJoin(companionId, root, `${slug}.md`)
    await companion.file.writeFile(file, ensureSkillName(skillMd.text, slug))
    installedHostPath = file
  }

  const installed: InstalledSkill = {
    skillId,
    name,
    targetId,
    path: formatLocator({ companionId, path: installedHostPath }),
    origin,
  }

  const manifest = await readManifest(companion, companionId, hostCwd)
  const next = manifest.filter((m) => !(m.skillId === skillId && m.targetId === targetId))
  next.push(installed)
  await writeManifest(companion, companionId, hostCwd, next)

  return { installed, warnings }
}

// ---------------------------------------------------------------------------
// Read a skill's files back out of a workspace install (for agent → agent copy
// and for promoting to global).
// ---------------------------------------------------------------------------

async function readDirRec(companion: Companion, companionId: string, dir: string, base = ''): Promise<SkillFile[]> {
  const out: SkillFile[] = []
  let nodes
  try { nodes = await companion.file.readDir(dir) } catch { return out }
  for (const n of nodes) {
    const child = hostJoin(companionId, dir, n.name)
    const rel = base ? `${base}/${n.name}` : n.name
    if (n.isDirectory) {
      out.push(...(await readDirRec(companion, companionId, child, rel)))
    } else {
      try { out.push({ relPath: rel, text: await companion.file.readFile(child) }) } catch { /* skip */ }
    }
  }
  return out
}

async function readWorkspaceSkillFiles(
  companion: Companion,
  companionId: string,
  hostCwd: string,
  targetId: SkillTargetId,
  name: string,
): Promise<SkillFile[]> {
  const info = targetInfo(targetId)
  const slug = slugifySkillName(name)
  const root = skillsRootDir(targetId, companionId, hostCwd)
  if (info.layout === 'folder') {
    return readDirRec(companion, companionId, hostJoin(companionId, root, slug))
  }
  try {
    return [{ relPath: 'SKILL.md', text: await companion.file.readFile(hostJoin(companionId, root, `${slug}.md`)) }]
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// Public install / uninstall / list (workspace scope, no cache)
// ---------------------------------------------------------------------------

export async function install(entry: SkillEntry, targetId: SkillTargetId, cwd: string): Promise<WriteSkillResult> {
  const { companionId, path: hostCwd } = parseLocator(cwd)
  if (!hostCwd) throw new Error('Workspace has no folder open')
  const companion = companions.resolve(companionId)

  // Resolve files: existing agent install here → saved-library cache → GitHub.
  const manifest = await readManifest(companion, companionId, hostCwd)
  const existing = manifest.find((m) => m.skillId === entry.id)
  let files: SkillFile[] = []
  if (existing) {
    files = await readWorkspaceSkillFiles(companion, companionId, hostCwd, existing.targetId, existing.name)
  }
  if (!files.length) {
    files = (await skillStore.read(entry.id)) ?? []
  }
  if (!files.length) {
    files = await fetchSkillFiles(entry.source, getToken())
  }

  return writeSkillToWorkspace({ skillId: entry.id, name: entry.name, targetId, cwd, files, origin: 'local' })
}

export async function uninstall(
  skillId: string,
  name: string,
  targetId: SkillTargetId,
  cwd: string,
): Promise<void> {
  const { companionId, path: hostCwd } = parseLocator(cwd)
  if (!hostCwd) throw new Error('Workspace has no folder open')
  const companion = companions.resolve(companionId)
  const info = targetInfo(targetId)
  const slug = slugifySkillName(name)
  const root = skillsRootDir(targetId, companionId, hostCwd)
  const target = info.layout === 'folder'
    ? hostJoin(companionId, root, slug)
    : hostJoin(companionId, root, `${slug}.md`)
  try {
    await companion.file.remove(target)
  } catch (err) {
    log.warn('[skills] remove failed for %s: %O', target, err)
  }
  const manifest = await readManifest(companion, companionId, hostCwd)
  await writeManifest(companion, companionId, hostCwd, manifest.filter((m) => !(m.skillId === skillId && m.targetId === targetId)))
}

export async function listInstalled(cwd: string): Promise<InstalledSkill[]> {
  const { companionId, path: hostCwd } = parseLocator(cwd)
  if (!hostCwd) return []
  let companion: Companion
  try { companion = companions.resolve(companionId) } catch { return [] }
  return readManifest(companion, companionId, hostCwd)
}

// ---------------------------------------------------------------------------
// Starred library — starring a skill fetches its files once, caches them in
// userData, and records it. Unstarring drops both. Never touches a workspace;
// plain installs are NOT cached (only starred skills are).
// ---------------------------------------------------------------------------

export async function saveSkill(entry: SkillEntry): Promise<void> {
  if (!(await skillStore.has(entry.id))) {
    const files = await fetchSkillFiles(entry.source, getToken())
    if (!files.length) throw new Error('Could not fetch skill files')
    await skillStore.cache(entry.id, files)
  }
  savedSkills.addSaved({
    skillId: entry.id,
    name: entry.name,
    description: entry.description,
    source: entry.source,
    stars: entry.stars,
  })
}

export async function unsaveSkill(skillId: string): Promise<void> {
  savedSkills.removeSaved(skillId)
  await skillStore.remove(skillId).catch(() => { /* best effort */ })
}
