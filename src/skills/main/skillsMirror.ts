import { createHash, randomUUID } from 'crypto'
import log from '../../main/logger'
import { CATE_GITIGNORE_CONTENT } from '../../main/cateGitignore'
import { parseLocator } from '../../shared/runtimeLocator'
import { runtimes } from '../../main/runtime/runtimeManager'
import type { Runtime } from '../../main/runtime/types'
import { hostJoin } from '../../agent/main/agentDir'
import {
  isKnownSkillTarget,
  slugifySkillName,
  type InstalledSkill,
  type SkillTargetId,
} from '../../shared/skills'
import { pathKey } from '../../shared/pathUtils'
import { skillPathSegments } from './skillPath'
import { skillsRootDir, targetInfo } from './targets'

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

interface BundleFile {
  relPath: string
  bytes: Buffer
}

interface InstalledBundle {
  files: BundleFile[]
  path: string
  contentHash: string
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

function isMissingError(error: unknown): boolean {
  return (
    (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') ||
    (error instanceof Error && /ENOENT|no such file/i.test(error.message))
  )
}

function canonicalManifestPath(runtimeId: string, hostCwd: string): string {
  return hostJoin(runtimeId, hostCwd, '.cate', 'skills.json')
}

async function readCanonicalManifest(
  runtime: Runtime,
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
  runtime: Runtime,
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

async function mkdirp(
  runtime: Runtime,
  runtimeId: string,
  hostCwd: string,
  targetDir: string,
): Promise<void> {
  const rel = targetDir.slice(hostCwd.length).replace(/^[/\\]+/, '')
  let current = hostCwd
  for (const part of rel.split(/[/\\]+/).filter(Boolean)) {
    current = hostJoin(runtimeId, current, part)
    await runtime.file.mkdir(current)
  }
}

async function writeMirrorManifest(
  runtime: Runtime,
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
  await runtime.file.writeFile(
    mirrorManifestPath(runtimeId, hostCwd),
    `${JSON.stringify(manifest, null, 2)}\n`,
  )
}

async function readDirectory(
  runtime: Runtime,
  runtimeId: string,
  dir: string,
  base = '',
): Promise<BundleFile[]> {
  const nodes = await runtime.file.readDir(dir)
  const files: BundleFile[] = []
  for (const node of [...nodes].sort((a, b) => a.name.localeCompare(b.name))) {
    const child = hostJoin(runtimeId, dir, node.name)
    const relPath = base ? `${base}/${node.name}` : node.name
    if (node.isDirectory) {
      files.push(...await readDirectory(runtime, runtimeId, child, relPath))
    } else {
      skillPathSegments(relPath)
      files.push({ relPath, bytes: await runtime.file.readBinary(child) })
    }
  }
  return files
}

function hashBundle(files: BundleFile[]): string {
  const hash = createHash('sha256')
  for (const file of [...files].sort((a, b) => a.relPath.localeCompare(b.relPath))) {
    hash.update(file.relPath)
    hash.update('\0')
    hash.update(String(file.bytes.length))
    hash.update('\0')
    hash.update(file.bytes)
    hash.update('\0')
  }
  return hash.digest('hex')
}

function installedPath(
  runtimeId: string,
  hostCwd: string,
  entry: Pick<MirrorEntry, 'name' | 'targetId'>,
): string {
  const slug = slugifySkillName(entry.name)
  const root = skillsRootDir(entry.targetId, runtimeId, hostCwd)
  return targetInfo(entry.targetId).layout === 'folder'
    ? hostJoin(runtimeId, root, slug)
    : hostJoin(runtimeId, root, `${slug}.md`)
}

async function readInstalledBundle(
  runtime: Runtime,
  runtimeId: string,
  hostCwd: string,
  entry: Pick<MirrorEntry, 'name' | 'targetId'>,
): Promise<InstalledBundle | null> {
  const path = installedPath(runtimeId, hostCwd, entry)
  let stat
  try {
    stat = await runtime.file.stat(path)
  } catch (error) {
    if (isMissingError(error)) return null
    throw error
  }
  const layout = targetInfo(entry.targetId).layout
  if ((layout === 'folder' && !stat.isDirectory) || (layout === 'flat' && !stat.isFile)) {
    throw new Error(`Unexpected skill path type: ${path}`)
  }
  const files = layout === 'folder'
    ? await readDirectory(runtime, runtimeId, path)
    : [{ relPath: 'SKILL.md', bytes: await runtime.file.readBinary(path) }]
  return { files, path, contentHash: hashBundle(files) }
}

async function materializeBundle(
  runtime: Runtime,
  runtimeId: string,
  hostCwd: string,
  entry: Pick<MirrorEntry, 'name' | 'targetId'>,
  files: BundleFile[],
  replace: boolean,
): Promise<boolean> {
  const root = skillsRootDir(entry.targetId, runtimeId, hostCwd)
  const destination = installedPath(runtimeId, hostCwd, entry)
  const slug = slugifySkillName(entry.name)
  const layout = targetInfo(entry.targetId).layout
  const transactionId = randomUUID()
  const staging = layout === 'folder'
    ? hostJoin(runtimeId, hostCwd, '.cate', `.skills-mirror-stage-${slug}-${transactionId}`)
    : hostJoin(runtimeId, hostCwd, '.cate', `.skills-mirror-stage-${slug}-${transactionId}.md`)
  const backup = hostJoin(runtimeId, hostCwd, '.cate', `.skills-mirror-backup-${slug}-${transactionId}`)
  let preserveBackup = false

  await mkdirp(runtime, runtimeId, hostCwd, root)
  await mkdirp(runtime, runtimeId, hostCwd, hostJoin(runtimeId, hostCwd, '.cate'))
  try {
    if (layout === 'folder') {
      await mkdirp(runtime, runtimeId, hostCwd, staging)
      for (const file of files) {
        const segments = skillPathSegments(file.relPath)
        const target = hostJoin(runtimeId, staging, ...segments)
        if (segments.length > 1) {
          await mkdirp(
            runtime,
            runtimeId,
            hostCwd,
            hostJoin(runtimeId, staging, ...segments.slice(0, -1)),
          )
        }
        await runtime.file.writeBinary(target, file.bytes)
      }
    } else {
      const skillMd = files.find((file) => file.relPath === 'SKILL.md')
      if (!skillMd) throw new Error('Skill is missing SKILL.md')
      await runtime.file.writeBinary(staging, skillMd.bytes)
    }

    if (!replace) {
      try {
        await runtime.file.stat(destination)
        return false
      } catch (error) {
        if (!isMissingError(error)) throw error
      }
    } else {
      await runtime.file.rename(destination, backup)
      try {
        await runtime.file.rename(staging, destination)
      } catch (error) {
        try {
          await runtime.file.rename(backup, destination)
        } catch (rollbackError) {
          preserveBackup = true
          const message = rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
          throw new Error(`Skill update failed and rollback failed; backup retained at ${backup}: ${message}`, {
            cause: error,
          })
        }
        throw error
      }
      return true
    }
    await runtime.file.rename(staging, destination)
    return true
  } finally {
    try { await runtime.file.remove(staging) } catch { /* already renamed or best-effort cleanup */ }
    if (replace && !preserveBackup) {
      try { await runtime.file.remove(backup) } catch { /* already restored or best-effort cleanup */ }
    }
  }
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
): Promise<SkillMirrorSyncResult> {
  const result = emptyResult()
  if (sameLocator(baseCwd, targetCwd)) return result

  const base = parseLocator(baseCwd)
  const target = parseLocator(targetCwd)
  if (!base.path || !target.path) {
    warn(result, 'Workspace has no folder open')
    return result
  }

  let baseRuntime: Runtime
  let targetRuntime: Runtime
  try {
    baseRuntime = runtimes.resolve(base.runtimeId)
    targetRuntime = runtimes.resolve(target.runtimeId)
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

  // First retire ownership whose source disappeared or moved to another slug.
  for (const [key, prior] of [...owned]) {
    const source = sourceByKey.get(key)
    if (source?.name === prior.name) continue
    try {
      const current = await readInstalledBundle(targetRuntime, target.runtimeId, target.path, prior)
      if (!current) {
        owned.delete(key)
      } else if (current.contentHash === prior.contentHash) {
        await targetRuntime.file.remove(current.path)
        owned.delete(key)
        result.removed.push(key)
      } else {
        owned.delete(key)
        result.preserved.push(key)
      }
    } catch (error) {
      warn(result, `Could not retire mirrored skill ${key}`, error)
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
      warn(result, `Could not synchronize skill ${key}`, error)
    }
  }

  try {
    await writeMirrorManifest(targetRuntime, target.runtimeId, target.path, owned.values())
  } catch (error) {
    warn(result, 'Could not write skill mirror ownership metadata', error)
  }
  return result
}
