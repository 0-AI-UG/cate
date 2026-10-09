// Mirrors the root's Cate-managed skills into a worktree checkout. The root's
// `.cate/skills.json` is the only desired state; the checkout gets ownership
// metadata (`.cate/skills-mirror.json`), never a second manifest.

import path from 'node:path'
import type { Logger } from '@kernel/log/contract'
import type { InstalledSkill, SkillMirrorSyncResult, SkillTargetId } from '../contract'
import { dirKey, isMissingError, writeSkillJson, type SkillFiles, type WithDirs } from './files'
import { materializeBundle, mkdirp, readInstalledBundle, retireBundle, withBundleTransaction } from './bundle'
import { manifestPath } from './installer'
import type { TargetTable } from './targets'

const MIRROR_VERSION = 1

interface MirrorEntry {
  skillId: string
  name: string
  targetId: SkillTargetId
  contentHash: string
}

interface MirrorManifest {
  version: typeof MIRROR_VERSION
  skills: MirrorEntry[]
}

export interface SkillMirrorDeps {
  files: SkillFiles
  targets: TargetTable
  withDirs: WithDirs
  log: Logger
  /** Writes `<dir>/.gitignore` when missing (workspace/lifecycle owns its
   *  content). */
  ensureCateGitignore?: (cateDir: string) => Promise<void>
}

function emptyResult(): SkillMirrorSyncResult {
  return { copied: [], updated: [], removed: [], preserved: [], warnings: [] }
}

function entryKey(entry: Pick<MirrorEntry, 'skillId' | 'targetId'>): string {
  return `${entry.skillId}:${entry.targetId}`
}

function mirrorManifestPath(cwd: string): string {
  return path.join(cwd, '.cate', 'skills-mirror.json')
}

export function createSkillMirror(deps: SkillMirrorDeps) {
  const { files, targets, withDirs, log } = deps

  async function readCanonicalManifest(cwd: string): Promise<InstalledSkill[]> {
    const parsed = JSON.parse(await files.readFile(manifestPath(cwd))) as { skills?: InstalledSkill[] }
    if (!Array.isArray(parsed.skills)) throw new Error('Canonical skills manifest has no skills array')
    return parsed.skills.filter((entry) =>
      typeof entry?.skillId === 'string' && typeof entry?.name === 'string' && targets.isKnown(entry?.targetId),
    )
  }

  async function readMirrorManifest(cwd: string): Promise<MirrorManifest> {
    try {
      const parsed = JSON.parse(await files.readFile(mirrorManifestPath(cwd))) as Partial<MirrorManifest>
      const skills = Array.isArray(parsed.skills)
        ? parsed.skills.filter((entry): entry is MirrorEntry =>
            typeof entry?.skillId === 'string' &&
            typeof entry?.name === 'string' &&
            typeof entry?.contentHash === 'string' &&
            targets.isKnown(entry?.targetId),
          )
        : []
      return { version: MIRROR_VERSION, skills }
    } catch {
      // Missing or corrupt ownership metadata grants Cate no ownership.
      return { version: MIRROR_VERSION, skills: [] }
    }
  }

  async function writeMirrorManifest(cwd: string, entries: Iterable<MirrorEntry>): Promise<void> {
    const cateDir = path.join(cwd, '.cate')
    await mkdirp(files, cwd, cateDir)
    if (deps.ensureCateGitignore) {
      try { await deps.ensureCateGitignore(cateDir) } catch { /* best effort */ }
    }
    const manifest: MirrorManifest = {
      version: MIRROR_VERSION,
      skills: [...entries].sort((a, b) => entryKey(a).localeCompare(entryKey(b))),
    }
    await writeSkillJson(files, mirrorManifestPath(cwd), manifest)
  }

  function warn(result: SkillMirrorSyncResult, message: string, error?: unknown): void {
    const detail = error instanceof Error ? `${message}: ${error.message}` : message
    result.warnings.push(detail)
    log.warn('mirror: %s', detail)
  }

  /** Best effort: failures come back as warnings and are retried by the next
   *  sync. */
  async function sync(base: string, target: string): Promise<SkillMirrorSyncResult> {
    if (dirKey(base) === dirKey(target)) return emptyResult()
    try {
      return await withDirs([base, target], () => withBundleTransaction(() => syncLocked(base, target)))
    } catch (error) {
      const result = emptyResult()
      warn(result, 'Could not synchronize skill bundles', error)
      return result
    }
  }

  async function syncLocked(base: string, target: string): Promise<SkillMirrorSyncResult> {
    const result = emptyResult()
    const mirror = await readMirrorManifest(target)
    const owned = new Map<string, MirrorEntry>()
    for (const entry of mirror.skills) owned.set(entryKey(entry), entry)

    let installed: InstalledSkill[]
    try {
      installed = await readCanonicalManifest(base)
    } catch (error) {
      // A workspace with no installed skills has no manifest. Stay quiet unless
      // ownership exists that must not be mistaken for stale desired state.
      if (!isMissingError(error) || owned.size > 0) warn(result, 'Could not read canonical skills manifest', error)
      return result
    }

    const sourceByKey = new Map<string, InstalledSkill>()
    for (const entry of installed) sourceByKey.set(entryKey(entry), entry)
    const initiallyOwned = new Map(owned)

    // First retire ownership whose source disappeared or moved to another slug.
    for (const [key, prior] of [...owned]) {
      const source = sourceByKey.get(key)
      if (source?.name === prior.name) continue
      // Consumer roots share the canonical entry's ownership: retire each
      // unedited copy before dropping that record.
      for (const root of targets.rootDirs(prior.targetId, target).slice(1)) {
        const mirrored = await readInstalledBundle(files, targets, target, prior, root)
        if (mirrored?.contentHash === prior.contentHash) await retireBundle(files, target, mirrored.path)
      }
      const current = await readInstalledBundle(files, targets, target, prior)
      if (!current) {
        owned.delete(key)
      } else if (current.contentHash === prior.contentHash) {
        await retireBundle(files, target, current.path)
        owned.delete(key)
        result.removed.push(key)
      } else {
        owned.delete(key)
        result.preserved.push(key)
      }
    }

    for (const [key, source] of sourceByKey) {
      const sourceBundle = await readInstalledBundle(files, targets, base, source)
      if (!sourceBundle) {
        warn(result, `Canonical skill files are missing for ${key}`)
        continue
      }
      const prior = owned.get(key)
      const current = await readInstalledBundle(files, targets, target, source)
      if (!prior) {
        if (current || !await materializeBundle(files, targets, target, source, sourceBundle.files, false)) {
          result.preserved.push(key)
          continue
        }
        owned.set(key, { skillId: source.skillId, name: source.name, targetId: source.targetId, contentHash: sourceBundle.contentHash })
        result.copied.push(key)
        continue
      }
      if (!current) {
        if (!await materializeBundle(files, targets, target, source, sourceBundle.files, false)) {
          owned.delete(key)
          result.preserved.push(key)
          continue
        }
        owned.set(key, { ...prior, name: source.name, contentHash: sourceBundle.contentHash })
        result.copied.push(key)
      } else if (current.contentHash !== prior.contentHash) {
        owned.delete(key)
        result.preserved.push(key)
      } else if (current.contentHash !== sourceBundle.contentHash) {
        await materializeBundle(files, targets, target, source, sourceBundle.files, true)
        owned.set(key, { ...prior, name: source.name, contentHash: sourceBundle.contentHash })
        result.updated.push(key)
      }
    }

    // Extra consumer roots of a target are reconciled from the same source
    // bundle and ownership record; they are not separate rows or targets.
    for (const [key] of owned) {
      const source = sourceByKey.get(key)
      if (!source) continue
      const sourceBundle = await readInstalledBundle(files, targets, base, source)
      if (!sourceBundle) continue
      const previous = initiallyOwned.get(key)
      for (const root of targets.rootDirs(source.targetId, target).slice(1)) {
        const current = await readInstalledBundle(files, targets, target, source, root)
        if (current?.contentHash === sourceBundle.contentHash) continue
        if (!current) {
          await materializeBundle(files, targets, target, source, sourceBundle.files, false, root)
          continue
        }
        if (previous && current.contentHash === previous.contentHash) {
          await materializeBundle(files, targets, target, source, sourceBundle.files, true, root)
          continue
        }
        if (!result.preserved.includes(key)) result.preserved.push(key)
      }
    }

    await writeMirrorManifest(target, owned.values())
    return result
  }

  return { sync }
}
