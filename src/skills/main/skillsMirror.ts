import log from '../../main/logger'
import { CATE_GITIGNORE_CONTENT } from '../../main/cateGitignore'
import { parseLocator } from '../../shared/runtimeLocator'
import { runtimes } from '../../main/runtime/runtimeManager'
import type { FileAccessContext } from '../../main/runtime/types'
import { scopedSkillFiles, withSkillWorkspaces, writeSkillJson, type SkillFileHost } from './skillWorkspace'
import { withBundleTransaction, retireBundle, isMissingError, mkdirp, readInstalledBundle, materializeBundle } from './skillBundle'
import { hostJoin } from '../../main/cateApi/hostPath'
import {
  isKnownSkillTarget,
  type InstalledSkill,
  type SkillTargetId,
} from '../../shared/skills'
import { pathKey } from '../../shared/pathUtils'
import { skillsRootDirs } from './targets'

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

export interface SkillMirrorSyncResult {
  copied: string[]
  updated: string[]
  removed: string[]
  preserved: string[]
  warnings: string[]
}

function emptyResult(): SkillMirrorSyncResult {
  return { copied: [], updated: [], removed: [], preserved: [], warnings: [] }
}

function entryKey(entry: Pick<MirrorEntry, 'skillId' | 'targetId'>): string {
  return `${entry.skillId}:${entry.targetId}`
}

function sameLocator(a: string, b: string): boolean {
  const left = parseLocator(a)
  const right = parseLocator(b)
  return left.runtimeId === right.runtimeId && pathKey(left.path) === pathKey(right.path)
}

function mirrorManifestPath(runtimeId: string, hostCwd: string): string {
  return hostJoin(runtimeId, hostCwd, '.cate', 'skills-mirror.json')
}

function canonicalManifestPath(runtimeId: string, hostCwd: string): string {
  return hostJoin(runtimeId, hostCwd, '.cate', 'skills.json')
}

async function readCanonicalManifest(
  runtime: SkillFileHost,
  runtimeId: string,
  hostCwd: string,
): Promise<InstalledSkill[]> {
  const raw = await runtime.file.readFile(canonicalManifestPath(runtimeId, hostCwd))
  const parsed = JSON.parse(raw) as { skills?: InstalledSkill[] }
  if (!Array.isArray(parsed.skills)) throw new Error('Canonical skills manifest has no skills array')
  return parsed.skills.filter((entry) =>
    typeof entry?.skillId === 'string' &&
    typeof entry?.name === 'string' &&
    isKnownSkillTarget(entry?.targetId),
  )
}

async function readMirrorManifest(
  runtime: SkillFileHost,
  runtimeId: string,
  hostCwd: string,
): Promise<MirrorManifest> {
  try {
    const raw = await runtime.file.readFile(mirrorManifestPath(runtimeId, hostCwd))
    const parsed = JSON.parse(raw) as Partial<MirrorManifest>
    const skills = Array.isArray(parsed.skills)
      ? parsed.skills.filter((entry): entry is MirrorEntry =>
          typeof entry?.skillId === 'string' &&
          typeof entry?.name === 'string' &&
          typeof entry?.contentHash === 'string' &&
          isKnownSkillTarget(entry?.targetId),
        )
      : []
    return { version: MIRROR_VERSION, skills }
  } catch {
    // Missing or corrupt ownership metadata grants Cate no ownership.
    return { version: MIRROR_VERSION, skills: [] }
  }
}

async function writeMirrorManifest(
  runtime: SkillFileHost,
  runtimeId: string,
  hostCwd: string,
  entries: Iterable<MirrorEntry>,
): Promise<void> {
  await mkdirp(runtime, runtimeId, hostCwd, hostJoin(runtimeId, hostCwd, '.cate'))
  const gitignore = hostJoin(runtimeId, hostCwd, '.cate', '.gitignore')
  try {
    await runtime.file.stat(gitignore)
  } catch (error) {
    if (isMissingError(error)) {
      try { await runtime.file.writeFile(gitignore, CATE_GITIGNORE_CONTENT) } catch { /* best effort */ }
    }
  }
  const manifest: MirrorManifest = {
    version: MIRROR_VERSION,
    skills: [...entries].sort((a, b) => entryKey(a).localeCompare(entryKey(b))),
  }
  await writeSkillJson(runtime, mirrorManifestPath(runtimeId, hostCwd), manifest)
}

function warn(result: SkillMirrorSyncResult, message: string, error?: unknown): void {
  const detail = error instanceof Error ? `${message}: ${error.message}` : message
  result.warnings.push(detail)
  log.warn('[skills-mirror] %s', detail)
}

/**
 * Materialize Cate-managed skills from a base workspace into another checkout.
 *
 * The base `.cate/skills.json` is the only desired-state manifest. The target
 * receives ownership metadata, never another normal skills manifest. This is
 * best effort: entry failures are returned as warnings and retried by later
 * launch/worktree sync calls.
 */
export async function syncWorkspaceSkills(
  baseCwd: string,
  targetCwd: string,
  access?: FileAccessContext,
): Promise<SkillMirrorSyncResult> {
  try {
    return await withSkillWorkspaces([baseCwd, targetCwd], () => withBundleTransaction(() => syncWorkspaceSkillsLocked(baseCwd, targetCwd, access)))
  } catch (error) {
    const result = emptyResult()
    warn(result, 'Could not synchronize skill bundles', error)
    return result
  }
}

async function syncWorkspaceSkillsLocked(baseCwd: string, targetCwd: string, access?: FileAccessContext): Promise<SkillMirrorSyncResult> {
  const result = emptyResult()
  if (sameLocator(baseCwd, targetCwd)) return result

  const base = parseLocator(baseCwd)
  const target = parseLocator(targetCwd)
  if (!base.path || !target.path) {
    warn(result, 'Workspace has no folder open')
    return result
  }

  let baseRuntime: SkillFileHost
  let targetRuntime: SkillFileHost
  try {
    baseRuntime = scopedSkillFiles(runtimes.resolve(base.runtimeId), access)
    targetRuntime = scopedSkillFiles(runtimes.resolve(target.runtimeId), access)
  } catch (error) {
    warn(result, 'Workspace runtime is unavailable', error)
    return result
  }

  const mirror = await readMirrorManifest(targetRuntime, target.runtimeId, target.path)
  const owned = new Map<string, MirrorEntry>()
  for (const entry of mirror.skills) owned.set(entryKey(entry), entry)

  let installed: InstalledSkill[]
  try {
    installed = await readCanonicalManifest(baseRuntime, base.runtimeId, base.path)
  } catch (error) {
    // A workspace with no installed skills normally has no manifest. Stay quiet
    // unless ownership exists that must not be mistaken for stale desired state.
    if (!isMissingError(error) || owned.size > 0) {
      warn(result, 'Could not read canonical skills manifest', error)
    }
    return result
  }

  const sourceByKey = new Map<string, InstalledSkill>()
  for (const entry of installed) sourceByKey.set(entryKey(entry), entry)
  const initiallyOwned = new Map(owned)

  // First retire ownership whose source disappeared or moved to another slug.
  for (const [key, prior] of [...owned]) {
    const source = sourceByKey.get(key)
    if (source?.name === prior.name) continue
    try {
      // Transparent consumer roots share the canonical entry's ownership. Retire
      // each unedited copy before dropping that single ownership record.
      for (const root of skillsRootDirs(prior.targetId, target.runtimeId, target.path).slice(1)) {
        const mirrored = await readInstalledBundle(
          targetRuntime,
          target.runtimeId,
          target.path,
          prior,
          root,
        )
        if (mirrored?.contentHash === prior.contentHash) {
          await retireBundle(targetRuntime, target.runtimeId, target.path, mirrored.path)
        }
      }
      const current = await readInstalledBundle(targetRuntime, target.runtimeId, target.path, prior)
      if (!current) {
        owned.delete(key)
      } else if (current.contentHash === prior.contentHash) {
        await retireBundle(targetRuntime, target.runtimeId, target.path, current.path)
        owned.delete(key)
        result.removed.push(key)
      } else {
        owned.delete(key)
        result.preserved.push(key)
      }
    } catch (error) {
      throw error
    }
  }

  for (const [key, source] of sourceByKey) {
    try {
      const sourceBundle = await readInstalledBundle(baseRuntime, base.runtimeId, base.path, source)
      if (!sourceBundle) {
        warn(result, `Canonical skill files are missing for ${key}`)
        continue
      }

      const prior = owned.get(key)
      const current = await readInstalledBundle(targetRuntime, target.runtimeId, target.path, source)
      if (!prior) {
        if (current) {
          result.preserved.push(key)
          continue
        }
        if (!await materializeBundle(
          targetRuntime,
          target.runtimeId,
          target.path,
          source,
          sourceBundle.files,
          false,
        )) {
          result.preserved.push(key)
          continue
        }
        owned.set(key, {
          skillId: source.skillId,
          name: source.name,
          targetId: source.targetId,
          contentHash: sourceBundle.contentHash,
        })
        result.copied.push(key)
        continue
      }

      if (!current) {
        const copied = await materializeBundle(
          targetRuntime,
          target.runtimeId,
          target.path,
          source,
          sourceBundle.files,
          false,
        )
        if (!copied) {
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
        await materializeBundle(
          targetRuntime,
          target.runtimeId,
          target.path,
          source,
          sourceBundle.files,
          true,
        )
        owned.set(key, { ...prior, name: source.name, contentHash: sourceBundle.contentHash })
        result.updated.push(key)
      }
    } catch (error) {
      throw error
    }
  }

  // A target may declare extra consumer roots (for example an isolated agent
  // process that reads the same target). Reconcile those from the same source
  // bundle and ownership record; they are deliberately not separate manifest
  // rows or UI targets.
  for (const [key] of owned) {
    const source = sourceByKey.get(key)
    if (!source) continue
    try {
      const sourceBundle = await readInstalledBundle(baseRuntime, base.runtimeId, base.path, source)
      if (!sourceBundle) continue
      const previous = initiallyOwned.get(key)
      for (const root of skillsRootDirs(source.targetId, target.runtimeId, target.path).slice(1)) {
        const current = await readInstalledBundle(
          targetRuntime,
          target.runtimeId,
          target.path,
          source,
          root,
        )
        if (current?.contentHash === sourceBundle.contentHash) continue
        if (!current) {
          await materializeBundle(
            targetRuntime,
            target.runtimeId,
            target.path,
            source,
            sourceBundle.files,
            false,
            root,
          )
          continue
        }
        if (previous && current.contentHash === previous.contentHash) {
          await materializeBundle(
            targetRuntime,
            target.runtimeId,
            target.path,
            source,
            sourceBundle.files,
            true,
            root,
          )
          continue
        }
        if (!result.preserved.includes(key)) result.preserved.push(key)
      }
    } catch (error) {
      throw error
    }
  }

  try {
    await writeMirrorManifest(targetRuntime, target.runtimeId, target.path, owned.values())
  } catch (error) {
    throw error
  }
  return result
}
