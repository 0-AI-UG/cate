// Writes skills into a workspace's agent dirs and tracks them in
// `<cwd>/.cate/skills.json`.

import path from 'node:path'
import { slugifySkillName, type InstalledSkill, type SkillFile, type SkillInstallResult, type SkillTargetId } from '../contract'
import { writeSkillJson, type SkillFiles, type WithDirs } from './files'
import {
  fileHashes,
  materializeBundle,
  prepareBundle,
  readInstalledBundle,
  reconcileManagedBundle,
  retireBundle,
  skillFiles,
  withBundleTransaction,
} from './bundle'
import type { TargetTable } from './targets'

interface SkillsManifest {
  skills: InstalledSkill[]
  /** Seed markers (`<skillId>:<targetId>@<contentHash>`): which bundled
   *  version was seeded, so an unedited copy can be refreshed while a user
   *  uninstall sticks and an edited copy is never overwritten. */
  seeded?: string[]
}

interface WriteSkillArgs {
  skillId: string
  name: string
  targetId: SkillTargetId
  cwd: string
  files: SkillFile[]
}

export function manifestPath(cwd: string): string {
  return path.join(cwd, '.cate', 'skills.json')
}

export type SkillInstaller = ReturnType<typeof createSkillInstaller>

export function createSkillInstaller(deps: { files: SkillFiles; targets: TargetTable; withDirs: WithDirs }) {
  const { files, targets, withDirs } = deps

  async function readManifestData(cwd: string): Promise<SkillsManifest> {
    try {
      const parsed = JSON.parse(await files.readFile(manifestPath(cwd))) as SkillsManifest
      return {
        // Rows for targets this version no longer has are dropped on read (the
        // next write persists that); their files on disk are left alone.
        skills: Array.isArray(parsed.skills) ? parsed.skills.filter((s) => targets.isKnown(s?.targetId)) : [],
        seeded: Array.isArray(parsed.seeded) ? parsed.seeded.filter((s) => typeof s === 'string') : [],
      }
    } catch {
      return { skills: [], seeded: [] }
    }
  }

  async function writeManifest(cwd: string, manifest: SkillsManifest): Promise<void> {
    await files.mkdir(path.join(cwd, '.cate'))
    const out: SkillsManifest = manifest.seeded?.length ? manifest : { skills: manifest.skills }
    await writeSkillJson(files, manifestPath(cwd), out)
  }

  async function readManifest(cwd: string): Promise<InstalledSkill[]> {
    return (await readManifestData(cwd)).skills
  }

  async function readSeededMarkers(cwd: string): Promise<string[]> {
    return (await readManifestData(cwd)).seeded ?? []
  }

  /** Replaces an earlier marker for the same skill and target (the part
   *  before the `@<hash>` suffix). */
  function setSeededMarker(cwd: string, marker: string): Promise<void> {
    return withDirs([cwd], async () => {
      const base = marker.split('@')[0]
      const manifest = await readManifestData(cwd)
      if (manifest.seeded?.includes(marker)) return
      const seeded = (manifest.seeded ?? []).filter((m) => m !== base && !m.startsWith(`${base}@`))
      await writeManifest(cwd, { ...manifest, seeded: [...seeded, marker] })
    })
  }

  function writeSkill(args: WriteSkillArgs): Promise<SkillInstallResult> {
    return withDirs([args.cwd], () => withBundleTransaction(() => writeSkillLocked(args)))
  }

  async function writeSkillLocked(args: WriteSkillArgs): Promise<SkillInstallResult> {
    const { skillId, name, targetId, cwd } = args
    const info = targets.get(targetId)
    const slug = slugifySkillName(name)
    const roots = targets.rootDirs(targetId, cwd)
    const warnings: string[] = []
    const prepared = prepareBundle(args.files, slug)
    if (!prepared.some(file => file.relPath === 'SKILL.md')) throw new Error('Skill is missing SKILL.md')
    const desired = info.layout === 'folder' ? prepared : prepared.filter(file => file.relPath === 'SKILL.md')
    if (desired.length < prepared.length) warnings.push(`${info.label} supports single-file skills only; ${prepared.length - desired.length} bundled file(s) were not installed.`)
    const manifest = await readManifestData(cwd)
    const previous = manifest.skills.find(entry => entry.skillId === skillId && entry.targetId === targetId)
    const conflicting = manifest.skills.find(row => row.targetId === targetId && row.skillId !== skillId && slugifySkillName(row.name) === slug)
    if (conflicting) throw new Error(`Skill destination already owned by ${conflicting.skillId}`)
    for (const root of roots) {
      const current = await readInstalledBundle(files, targets, cwd, { name, targetId }, root)
      const next = reconcileManagedBundle(current?.files ?? [], desired, previous?.managedFiles, true)
      await materializeBundle(files, targets, cwd, { name, targetId }, next.files, !!current, root)
    }
    if (previous && slugifySkillName(previous.name) !== slug && !manifest.skills.some(row => row.skillId !== skillId && row.targetId === targetId && slugifySkillName(row.name) === slugifySkillName(previous.name))) {
      for (const root of roots) {
        const old = await readInstalledBundle(files, targets, cwd, previous, root)
        if (!old) continue
        const hashes = fileHashes(old.files)
        const preserved = old.files.filter(file => previous.managedFiles?.[file.relPath] !== hashes[file.relPath])
        if (preserved.length) await materializeBundle(files, targets, cwd, previous, preserved, true, root)
        else await retireBundle(files, cwd, old.path)
      }
    }
    const installed: InstalledSkill = {
      skillId,
      name,
      targetId,
      path: info.layout === 'folder' ? path.join(roots[0], slug, 'SKILL.md') : path.join(roots[0], `${slug}.md`),
      origin: 'local',
      managedFiles: fileHashes(desired),
    }
    const next = manifest.skills.filter((m) => !(m.skillId === skillId && m.targetId === targetId))
    next.push(installed)
    await writeManifest(cwd, { ...manifest, skills: next })
    return { installed, warnings }
  }

  /** A skill's files read back from an install (agent to agent copy, offline
   *  fallback). */
  async function readWorkspaceSkillFiles(cwd: string, targetId: SkillTargetId, name: string): Promise<SkillFile[]> {
    const bundle = await readInstalledBundle(files, targets, cwd, { targetId, name })
    return bundle ? skillFiles(bundle.files) : []
  }

  function uninstall(skillId: string, targetId: SkillTargetId, cwd: string): Promise<void> {
    return withDirs([cwd], () => withBundleTransaction(async () => {
      const manifest = await readManifestData(cwd)
      const owned = manifest.skills.find(row => row.skillId === skillId && row.targetId === targetId)
      if (!owned) return
      const info = targets.get(targetId)
      const slug = slugifySkillName(owned.name)
      const shared = manifest.skills.some(row => row.skillId !== skillId && row.targetId === targetId && slugifySkillName(row.name) === slug)
      if (!shared) {
        for (const root of targets.rootDirs(targetId, cwd)) {
          await retireBundle(files, cwd, info.layout === 'folder' ? path.join(root, slug) : path.join(root, `${slug}.md`))
        }
      }
      await writeManifest(cwd, {
        ...manifest,
        skills: manifest.skills.filter((m) => !(m.skillId === skillId && m.targetId === targetId)),
      })
    }))
  }

  return { readManifest, readSeededMarkers, setSeededMarker, writeSkill, readWorkspaceSkillFiles, uninstall }
}
