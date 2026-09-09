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
import { parseLocator, formatLocator } from '../../shared/runtimeLocator'
import { runtimes } from '../../main/runtime/runtimeManager'
import { hostJoin } from '../../main/cateApi/hostPath'
import type { FileAccessContext } from '../../main/runtime/types'
import { KeyedLock } from '../../main/keyedLock'
import { scopedSkillFiles, withSkillWorkspaces, writeSkillJson, type SkillFileHost } from './skillWorkspace'
import { withBundleTransaction, retireBundle, prepareBundle, readInstalledBundle, materializeBundle, fileHashes, skillFiles, reconcileManagedBundle } from './skillBundle'
import { skillsRootDirs, targetInfo } from './targets'
import * as skillStore from './skillStore'
import * as savedSkills from './savedSkills'
import { getGithubToken } from '../../main/github/cli'
import {
  isKnownSkillTarget, slugifySkillName,
  type InstalledSkill, type SkillEntry, type SkillTargetId,
} from '../../shared/skills'
import { fetchSkillFiles, type SkillFile } from './githubCrawl'

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

async function readManifestData(runtime: SkillFileHost, runtimeId: string, hostCwd: string): Promise<SkillsManifest> {
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

export async function readManifest(runtime: SkillFileHost, runtimeId: string, hostCwd: string): Promise<InstalledSkill[]> {
  return (await readManifestData(runtime, runtimeId, hostCwd)).skills
}

async function writeManifest(runtime: SkillFileHost, runtimeId: string, hostCwd: string, manifest: SkillsManifest): Promise<void> {
  await runtime.file.mkdir(hostJoin(runtimeId, hostCwd, '.cate'))
  // Omit an empty seeded list so pre-seeding manifests round-trip unchanged.
  const out: SkillsManifest = manifest.seeded?.length ? manifest : { skills: manifest.skills }
  await writeSkillJson(runtime, manifestPath(runtimeId, hostCwd), out)
}

/** Seed markers for this workspace (see SkillsManifest.seeded). */
export async function readSeededMarkers(runtime: SkillFileHost, runtimeId: string, hostCwd: string): Promise<string[]> {
  return (await readManifestData(runtime, runtimeId, hostCwd)).seeded ?? []
}

/** Record that a bundled skill was seeded for a target in this workspace,
 *  replacing any earlier marker for the same skill+target (the part before the
 *  optional `@<hash>` version suffix). */
export async function setSeededMarker(runtime: SkillFileHost, runtimeId: string, hostCwd: string, marker: string): Promise<void> {
  return withSkillWorkspaces([formatLocator({ runtimeId, path: hostCwd })], () => setSeededMarkerLocked(runtime, runtimeId, hostCwd, marker))
}

async function setSeededMarkerLocked(runtime: SkillFileHost, runtimeId: string, hostCwd: string, marker: string): Promise<void> {
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
  access?: FileAccessContext
}

export interface WriteSkillResult {
  installed: InstalledSkill
  warnings: string[]
}

export async function writeSkillToWorkspace(args: WriteSkillArgs): Promise<WriteSkillResult> {
  return withSkillWorkspaces([args.cwd], () => withBundleTransaction(() => writeSkillLocked(args)))
}

async function writeSkillLocked(args: WriteSkillArgs): Promise<WriteSkillResult> {
  const { skillId, name, targetId, cwd, files, origin } = args
  const { runtimeId, path: hostCwd } = parseLocator(cwd)
  if (!hostCwd) throw new Error('Workspace has no folder open')
  const runtime = scopedSkillFiles(runtimes.resolve(runtimeId), args.access)
  const info = targetInfo(targetId)
  const slug = slugifySkillName(name)
  const roots = skillsRootDirs(targetId, runtimeId, hostCwd)
  const root = roots[0]

  const warnings: string[] = []
  const prepared = prepareBundle(files, slug)
  if (!prepared.some(file => file.relPath === 'SKILL.md')) throw new Error('Skill is missing SKILL.md')
  const desired = info.layout === 'folder' ? prepared : prepared.filter(file => file.relPath === 'SKILL.md')
  if (desired.length < prepared.length) warnings.push(`${info.label} supports single-file skills only; ${prepared.length - desired.length} bundled file(s) were not installed.`)
  const manifest = await readManifestData(runtime, runtimeId, hostCwd)
  const previous = manifest.skills.find(entry => entry.skillId === skillId && entry.targetId === targetId)
  const conflicting = manifest.skills.find(row => row.targetId === targetId && row.skillId !== skillId && slugifySkillName(row.name) === slug)
  if (conflicting) throw new Error(`Skill destination already owned by ${conflicting.skillId}`)
  for (const destinationRoot of roots) {
    const current = await readInstalledBundle(runtime, runtimeId, hostCwd, { name, targetId }, destinationRoot)
    const nextBundle = reconcileManagedBundle(current?.files ?? [], desired, previous?.managedFiles, true)
    await materializeBundle(runtime, runtimeId, hostCwd, { name, targetId }, nextBundle.files, !!current, destinationRoot)
  }
  if (previous && slugifySkillName(previous.name) !== slug && !manifest.skills.some(row => row.skillId !== skillId && row.targetId === targetId && slugifySkillName(row.name) === slugifySkillName(previous.name))) {
    for (const destinationRoot of roots) {
      const old = await readInstalledBundle(runtime, runtimeId, hostCwd, previous, destinationRoot)
      if (!old) continue
      const hashes = fileHashes(old.files)
      const preserved = old.files.filter(file => previous.managedFiles?.[file.relPath] !== hashes[file.relPath])
      if (preserved.length) await materializeBundle(runtime, runtimeId, hostCwd, previous, preserved, true, destinationRoot)
      else await retireBundle(runtime, runtimeId, hostCwd, old.path)
    }
  }
  const installedHostPath = info.layout === 'folder'
    ? hostJoin(runtimeId, root, slug, 'SKILL.md')
    : hostJoin(runtimeId, root, `${slug}.md`)

  const installed: InstalledSkill = {
    skillId,
    name,
    targetId,
    path: formatLocator({ runtimeId, path: installedHostPath }),
    origin,
    managedFiles: fileHashes(desired),
  }

  const next = manifest.skills.filter((m) => !(m.skillId === skillId && m.targetId === targetId))
  next.push(installed)
  await writeManifest(runtime, runtimeId, hostCwd, { ...manifest, skills: next })

  return { installed, warnings }
}

// ---------------------------------------------------------------------------
// Read a skill's files back out of a workspace install (for agent → agent copy
// and for promoting to global).
// ---------------------------------------------------------------------------

export async function readWorkspaceSkillFiles(
  runtime: SkillFileHost, runtimeId: string, hostCwd: string, targetId: SkillTargetId, name: string,
): Promise<SkillFile[]> {
  const bundle = await readInstalledBundle(runtime, runtimeId, hostCwd, { targetId, name })
  return bundle ? skillFiles(bundle.files) : []
}

// ---------------------------------------------------------------------------
// Public install / uninstall / list (workspace scope, no cache)
// ---------------------------------------------------------------------------

export async function install(entry: SkillEntry, targetId: SkillTargetId, cwd: string, access?: FileAccessContext): Promise<WriteSkillResult> {
  const { runtimeId, path: hostCwd } = parseLocator(cwd)
  if (!hostCwd) throw new Error('Workspace has no folder open')
  const runtime = scopedSkillFiles(runtimes.resolve(runtimeId), access)

  // The remote source is authoritative. Existing installs and the saved cache
  // are offline fallbacks, not a faster path: making them the first choice
  // caused a skill to remain stale forever once it had been installed/saved.
  const manifest = await readManifest(runtime, runtimeId, hostCwd)
  const existing = manifest.find((m) => m.skillId === entry.id)
  let files: SkillFile[] = []
  let fetchError: unknown
  if (entry.source.repo) {
    try {
      files = await fetchSkillFiles(entry.source, await getGithubToken())
      if (!files.length) throw new Error('Source returned no skill files')
      // A successful source read also repairs a stale saved-library cache. A
      // cache write is useful but must not block the workspace install.
      if (savedSkills.isSaved(entry.id)) {
        await libraryTransactions.run(entry.id, async () => { if (savedSkills.isSaved(entry.id)) await skillStore.cache(entry.id, files) }).catch((err) => {
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

  const result = await writeSkillToWorkspace({ skillId: entry.id, name: entry.name, targetId, cwd, files, origin: 'local', access })
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
  access?: FileAccessContext,
): Promise<void> {
  return withSkillWorkspaces([cwd], () => withBundleTransaction(() => uninstallLocked(skillId, name, targetId, cwd, access)))
}

async function uninstallLocked(skillId: string, name: string, targetId: SkillTargetId, cwd: string, access?: FileAccessContext): Promise<void> {
  const { runtimeId, path: hostCwd } = parseLocator(cwd)
  if (!hostCwd) throw new Error('Workspace has no folder open')
  const runtime = scopedSkillFiles(runtimes.resolve(runtimeId), access)
  const manifest = await readManifestData(runtime, runtimeId, hostCwd)
  const owned = manifest.skills.find(row => row.skillId === skillId && row.targetId === targetId)
  if (!owned) return
  const info = targetInfo(targetId)
  const slug = slugifySkillName(owned.name)
  const shared = manifest.skills.some(row => row.skillId !== skillId && row.targetId === targetId && slugifySkillName(row.name) === slug)
  for (const root of skillsRootDirs(targetId, runtimeId, hostCwd)) {
    const target = info.layout === 'folder'
      ? hostJoin(runtimeId, root, slug)
      : hostJoin(runtimeId, root, `${slug}.md`)
    if (shared) continue
    await retireBundle(runtime, runtimeId, hostCwd, target)
  }
  await writeManifest(runtime, runtimeId, hostCwd, {
    ...manifest,
    skills: manifest.skills.filter((m) => !(m.skillId === skillId && m.targetId === targetId)),
  })
}

export async function listInstalled(cwd: string, access?: FileAccessContext): Promise<InstalledSkill[]> {
  const { runtimeId, path: hostCwd } = parseLocator(cwd)
  if (!hostCwd) return []
  let runtime: SkillFileHost
  try { runtime = scopedSkillFiles(runtimes.resolve(runtimeId), access) } catch { return [] }
  return readManifest(runtime, runtimeId, hostCwd)
}

// ---------------------------------------------------------------------------
// Starred library — starring a skill fetches its files once, caches them in
// userData, and records it. Unstarring drops both. Never touches a workspace;
// plain installs are NOT cached (only starred skills are).
// ---------------------------------------------------------------------------

const libraryTransactions = new KeyedLock()
export function saveSkill(entry: SkillEntry): Promise<void> {
  return libraryTransactions.run(entry.id, () => withBundleTransaction(() => saveSkillLocked(entry)))
}
async function saveSkillLocked(entry: SkillEntry): Promise<void> {
  // Re-saving must refresh the bytes. `has()` used to make the first cached
  // copy permanent, even when a moving branch such as `main` changed later.
  try {
    const files = await fetchSkillFiles(entry.source, await getGithubToken())
    if (!files.length) throw new Error('Could not fetch skill files')
    await skillStore.cache(entry.id, files)
  } catch (err) {
    // Preserve the library's offline promise when a usable cache already
    // exists; without one, surface the fetch failure to the caller.
    if (!(await skillStore.has(entry.id))) throw err
    log.warn('[skills] source unavailable while saving %s; keeping cached copy: %O', entry.id, err)
  }
  await savedSkills.addSaved({
    skillId: entry.id,
    name: entry.name,
    description: entry.description,
    source: entry.source,
    stars: entry.stars,
  })
}

export function unsaveSkill(skillId: string): Promise<void> {
  return libraryTransactions.run(skillId, () => withBundleTransaction(async () => {
    await skillStore.remove(skillId)
    await savedSkills.removeSaved(skillId)
  }))
}
