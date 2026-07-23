// =============================================================================
// Skill install engine — writes a skill into a workspace's per-target dir via
// the runtime (local AND remote), and tracks installs in <ws>/.cate/skills.json.
//
// Resolving a skill's files for a workspace install:
//   - fetch the source first, so installing for another agent also updates an
//     old workspace/library copy instead of propagating stale bytes;
//   - if the source is unavailable, fall back to another local agent install,
//     then the saved-library cache, and surface an offline-copy warning.
// Saving (saveSkill) caches the bytes in skillStore + records the skill in the
// userData library; it never touches a workspace.
// =============================================================================

import log from '../../main/logger'
import { parseLocator, formatLocator } from '../../main/runtime/locator'
import { runtimes } from '../../main/runtime/runtimeManager'
import { hostJoin } from '../../agent/main/agentDir'
import type { Runtime } from '../../main/runtime/types'
import { skillsRootDir, targetInfo } from './targets'
import { ensureSkillName } from './frontmatter'
import * as skillStore from './skillStore'
import * as savedSkills from './savedSkills'
import { getToken } from './skillSources'
import {
  isKnownSkillTarget, slugifySkillName,
  type InstalledSkill, type SkillEntry, type SkillTargetId,
} from '../../shared/skills'
import { fetchSkillFiles, type SkillFile } from './githubCrawl'
import { skillPathSegments } from './skillPath'

// ---------------------------------------------------------------------------
// Manifest (<workspace>/.cate/skills.json)
// ---------------------------------------------------------------------------

interface SkillsManifest {
  skills: InstalledSkill[]
  /** Auto-seed markers ("<skillId>:<targetId>@<contentHash>"; older manifests
   *  carry hash-less "<skillId>:<targetId>" markers). The hash records WHICH
   *  bundle version was seeded, so a newer app can refresh an unedited copy
   *  while a user uninstall still sticks and a user-edited copy is never
   *  overwritten (see seedCateCliSkill for the policy). */
  seeded?: string[]
}

function manifestPath(runtimeId: string, hostCwd: string): string {
  return hostJoin(runtimeId, hostCwd, '.cate', 'skills.json')
}

async function readManifestData(runtime: Runtime, runtimeId: string, hostCwd: string): Promise<SkillsManifest> {
  try {
    const raw = await runtime.file.readFile(manifestPath(runtimeId, hostCwd))
    const parsed = JSON.parse(raw) as SkillsManifest
    return {
      // Rows for targets this Cate no longer supports (e.g. `antigravity`,
      // dropped with its agent) are filtered out on the way in: they would
      // otherwise render as a phantom agent in the skills tree, and reaching
      // targetInfo/skillsRootDir with one THROWS — which used to break
      // installing any skill that had a stale row for the same skillId. The
      // next manifest write persists the pruned list, so this self-heals.
      // Only the tracking row goes; files already on disk are left alone.
      skills: Array.isArray(parsed.skills)
        ? parsed.skills.filter((s) => isKnownSkillTarget(s?.targetId))
        : [],
      seeded: Array.isArray(parsed.seeded) ? parsed.seeded.filter((s) => typeof s === 'string') : [],
    }
  } catch {
    return { skills: [], seeded: [] }
  }
}

export async function readManifest(runtime: Runtime, runtimeId: string, hostCwd: string): Promise<InstalledSkill[]> {
  return (await readManifestData(runtime, runtimeId, hostCwd)).skills
}

async function writeManifest(runtime: Runtime, runtimeId: string, hostCwd: string, manifest: SkillsManifest): Promise<void> {
  await runtime.file.mkdir(hostJoin(runtimeId, hostCwd, '.cate'))
  // Omit an empty seeded list so pre-seeding manifests round-trip unchanged.
  const out: SkillsManifest = manifest.seeded?.length ? manifest : { skills: manifest.skills }
  await runtime.file.writeFile(manifestPath(runtimeId, hostCwd), `${JSON.stringify(out, null, 2)}\n`)
}

/** Seed markers for this workspace (see SkillsManifest.seeded). */
export async function readSeededMarkers(runtime: Runtime, runtimeId: string, hostCwd: string): Promise<string[]> {
  return (await readManifestData(runtime, runtimeId, hostCwd)).seeded ?? []
}

/** Record that a bundled skill was seeded for a target in this workspace,
 *  replacing any earlier marker for the same skill+target (the part before the
 *  optional `@<hash>` version suffix). */
export async function setSeededMarker(runtime: Runtime, runtimeId: string, hostCwd: string, marker: string): Promise<void> {
  const base = marker.split('@')[0]
  const manifest = await readManifestData(runtime, runtimeId, hostCwd)
  if (manifest.seeded?.includes(marker)) return
  const seeded = (manifest.seeded ?? []).filter((m) => m !== base && !m.startsWith(`${base}@`))
  await writeManifest(runtime, runtimeId, hostCwd, { ...manifest, seeded: [...seeded, marker] })
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
 *  `targetDir`. `runtime.file.mkdir` is recursive but its validation requires
 *  the IMMEDIATE parent to already exist, so we walk level by level — e.g. a
 *  fresh `.codex/skills` works even though `.codex` didn't exist yet. */
async function mkdirp(runtime: Runtime, runtimeId: string, hostCwd: string, targetDir: string): Promise<void> {
  if (!targetDir.startsWith(hostCwd)) {
    await runtime.file.mkdir(targetDir)
    return
  }
  const rel = targetDir.slice(hostCwd.length).replace(/^[/\\]+/, '')
  let cur = hostCwd
  for (const part of rel.split(/[/\\]+/).filter(Boolean)) {
    cur = hostJoin(runtimeId, cur, part)
    await runtime.file.mkdir(cur)
  }
}

async function writeFile(runtime: Runtime, hostPath: string, file: SkillFile, slug: string): Promise<void> {
  if (file.text != null) {
    const content = file.relPath === 'SKILL.md' ? ensureSkillName(file.text, slug) : file.text
    await runtime.file.writeFile(hostPath, content)
  } else if (file.base64 != null) {
    await runtime.file.writeBinary(hostPath, Buffer.from(file.base64, 'base64'))
  }
}

export async function writeSkillToWorkspace(args: WriteSkillArgs): Promise<WriteSkillResult> {
  const { skillId, name, targetId, cwd, files, origin } = args
  const { runtimeId, path: hostCwd } = parseLocator(cwd)
  if (!hostCwd) throw new Error('Workspace has no folder open')
  const runtime = runtimes.resolve(runtimeId)
  const info = targetInfo(targetId)
  const slug = slugifySkillName(name)
  const root = skillsRootDir(targetId, runtimeId, hostCwd)

  const warnings: string[] = []
  let installedHostPath: string

  if (info.layout === 'folder') {
    // Validate the complete bundle before creating directories or writing files,
    // so a malformed source cannot escape (or partially modify) the skill root.
    const bundle = files.map((file) => ({ file, segments: skillPathSegments(file.relPath) }))
    const dir = hostJoin(runtimeId, root, slug)
    await mkdirp(runtime, runtimeId, hostCwd, dir)
    for (const { file: f, segments: segs } of bundle) {
      const target = hostJoin(runtimeId, dir, ...segs)
      if (segs.length > 1) {
        await mkdirp(runtime, runtimeId, hostCwd, hostJoin(runtimeId, dir, ...segs.slice(0, -1)))
      }
      await writeFile(runtime, target, f, slug)
    }
    installedHostPath = hostJoin(runtimeId, dir, 'SKILL.md')
  } else {
    const skillMd = files.find((f) => f.relPath === 'SKILL.md')
    if (!skillMd?.text) throw new Error('Skill is missing SKILL.md')
    const extras = files.filter((f) => f.relPath !== 'SKILL.md')
    if (extras.length) {
      warnings.push(`${info.label} supports single-file skills only; ${extras.length} bundled file(s) were not installed.`)
    }
    await mkdirp(runtime, runtimeId, hostCwd, root)
    const file = hostJoin(runtimeId, root, `${slug}.md`)
    await runtime.file.writeFile(file, ensureSkillName(skillMd.text, slug))
    installedHostPath = file
  }

  const installed: InstalledSkill = {
    skillId,
    name,
    targetId,
    path: formatLocator({ runtimeId, path: installedHostPath }),
    origin,
  }

  const manifest = await readManifestData(runtime, runtimeId, hostCwd)
  const next = manifest.skills.filter((m) => !(m.skillId === skillId && m.targetId === targetId))
  next.push(installed)
  await writeManifest(runtime, runtimeId, hostCwd, { ...manifest, skills: next })

  return { installed, warnings }
}

// ---------------------------------------------------------------------------
// Read a skill's files back out of a workspace install (for agent → agent copy
// and for promoting to global).
// ---------------------------------------------------------------------------

async function readDirRec(runtime: Runtime, runtimeId: string, dir: string, base = ''): Promise<SkillFile[]> {
  const out: SkillFile[] = []
  let nodes
  try { nodes = await runtime.file.readDir(dir) } catch { return out }
  for (const n of nodes) {
    const child = hostJoin(runtimeId, dir, n.name)
    const rel = base ? `${base}/${n.name}` : n.name
    if (n.isDirectory) {
      out.push(...(await readDirRec(runtime, runtimeId, child, rel)))
    } else {
      try { out.push({ relPath: rel, text: await runtime.file.readFile(child) }) } catch { /* skip */ }
    }
  }
  return out
}

export async function readWorkspaceSkillFiles(
  runtime: Runtime,
  runtimeId: string,
  hostCwd: string,
  targetId: SkillTargetId,
  name: string,
): Promise<SkillFile[]> {
  const info = targetInfo(targetId)
  const slug = slugifySkillName(name)
  const root = skillsRootDir(targetId, runtimeId, hostCwd)
  if (info.layout === 'folder') {
    return readDirRec(runtime, runtimeId, hostJoin(runtimeId, root, slug))
  }
  try {
    return [{ relPath: 'SKILL.md', text: await runtime.file.readFile(hostJoin(runtimeId, root, `${slug}.md`)) }]
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// Public install / uninstall / list (workspace scope, no cache)
// ---------------------------------------------------------------------------

export async function install(entry: SkillEntry, targetId: SkillTargetId, cwd: string): Promise<WriteSkillResult> {
  const { runtimeId, path: hostCwd } = parseLocator(cwd)
  if (!hostCwd) throw new Error('Workspace has no folder open')
  const runtime = runtimes.resolve(runtimeId)

  // The remote source is authoritative. Existing installs and the saved cache
  // are offline fallbacks, not a faster path: making them the first choice
  // caused a skill to remain stale forever once it had been installed/saved.
  const manifest = await readManifest(runtime, runtimeId, hostCwd)
  const existing = manifest.find((m) => m.skillId === entry.id)
  let files: SkillFile[] = []
  let fetchError: unknown
  if (entry.source.repo) {
    try {
      files = await fetchSkillFiles(entry.source, getToken())
      if (!files.length) throw new Error('Source returned no skill files')
      // A successful source read also repairs a stale saved-library cache. A
      // cache write is useful but must not block the workspace install.
      if (savedSkills.isSaved(entry.id)) {
        await skillStore.cache(entry.id, files).catch((err) => {
          log.warn('[skills] could not refresh saved cache for %s: %O', entry.id, err)
        })
      }
    } catch (err) {
      fetchError = err
    }
  }
  if (!files.length && existing) {
    files = await readWorkspaceSkillFiles(runtime, runtimeId, hostCwd, existing.targetId, existing.name)
  }
  if (!files.length) {
    files = (await skillStore.read(entry.id)) ?? []
  }
  if (!files.length) {
    if (fetchError instanceof Error) throw fetchError
    throw new Error('Could not resolve skill files')
  }

  const result = await writeSkillToWorkspace({ skillId: entry.id, name: entry.name, targetId, cwd, files, origin: 'local' })
  if (fetchError) {
    result.warnings.unshift('Latest source unavailable; installed the existing offline copy.')
  }
  return result
}

export async function uninstall(
  skillId: string,
  name: string,
  targetId: SkillTargetId,
  cwd: string,
): Promise<void> {
  const { runtimeId, path: hostCwd } = parseLocator(cwd)
  if (!hostCwd) throw new Error('Workspace has no folder open')
  const runtime = runtimes.resolve(runtimeId)
  const info = targetInfo(targetId)
  const slug = slugifySkillName(name)
  const root = skillsRootDir(targetId, runtimeId, hostCwd)
  const target = info.layout === 'folder'
    ? hostJoin(runtimeId, root, slug)
    : hostJoin(runtimeId, root, `${slug}.md`)
  try {
    await runtime.file.remove(target)
  } catch (err) {
    log.warn('[skills] remove failed for %s: %O', target, err)
  }
  const manifest = await readManifestData(runtime, runtimeId, hostCwd)
  await writeManifest(runtime, runtimeId, hostCwd, {
    ...manifest,
    skills: manifest.skills.filter((m) => !(m.skillId === skillId && m.targetId === targetId)),
  })
}

export async function listInstalled(cwd: string): Promise<InstalledSkill[]> {
  const { runtimeId, path: hostCwd } = parseLocator(cwd)
  if (!hostCwd) return []
  let runtime: Runtime
  try { runtime = runtimes.resolve(runtimeId) } catch { return [] }
  return readManifest(runtime, runtimeId, hostCwd)
}

// ---------------------------------------------------------------------------
// Starred library — starring a skill fetches its files once, caches them in
// userData, and records it. Unstarring drops both. Never touches a workspace;
// plain installs are NOT cached (only starred skills are).
// ---------------------------------------------------------------------------

export async function saveSkill(entry: SkillEntry): Promise<void> {
  // Re-saving must refresh the bytes. `has()` used to make the first cached
  // copy permanent, even when a moving branch such as `main` changed later.
  try {
    const files = await fetchSkillFiles(entry.source, getToken())
    if (!files.length) throw new Error('Could not fetch skill files')
    await skillStore.cache(entry.id, files)
  } catch (err) {
    // Preserve the library's offline promise when a usable cache already
    // exists; without one, surface the fetch failure to the caller.
    if (!(await skillStore.has(entry.id))) throw err
    log.warn('[skills] source unavailable while saving %s; keeping cached copy: %O', entry.id, err)
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
