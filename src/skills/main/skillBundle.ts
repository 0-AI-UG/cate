import { AsyncLocalStorage } from 'node:async_hooks'
import log from '../../main/logger'
import { createHash, randomUUID } from 'crypto'
import { hostJoin } from '../../main/cateApi/hostPath'
import { slugifySkillName, type SkillTargetId } from '../../shared/skills'
import { skillsRootDir, targetInfo } from './targets'
import { skillPathSegments } from './skillPath'
import { ensureSkillName } from './frontmatter'
import type { SkillFile } from './githubCrawl'
import type { SkillFileHost } from './skillWorkspace'
interface BundlePublication {
  rollback(): Promise<void>
  cleanup(): Promise<void>
}
const publications = new AsyncLocalStorage<BundlePublication[]>()

/** Keep publication backups until both bytes and their ownership metadata are
 * committed. Nested cache/install helpers join the same operation. */
export async function withBundleTransaction<T>(action: () => Promise<T>): Promise<T> {
  if (publications.getStore()) return action()
  const changes: BundlePublication[] = []
  return publications.run(changes, async () => {
    let result: T
    try { result = await action() }
    catch (error) {
      const failures: unknown[] = []
      for (const change of changes.reverse()) {
        try { await change.rollback() } catch (rollbackError) { failures.push(rollbackError) }
      }
      if (failures.length) throw new AggregateError([error, ...failures], `Skill transaction failed; recovery required: ${failures.map(failure => failure instanceof Error ? failure.message : String(failure)).join('; ')}`, { cause: error })
      throw error
    }
    for (const change of changes) {
      try { await change.cleanup() } catch (error) { log.warn('[skills] committed transaction retained cleanup backup: %O', error) }
    }
    return result
  })
}

/** Removing a bundle is a publication too: hide it from discovery now, retain
 * its bytes until the ownership update commits, and restore it on rejection. */
export async function retireBundle(runtime: SkillFileHost, runtimeId: string, hostCwd: string, destination: string): Promise<void> {
  if (!publications.getStore()) return withBundleTransaction(() => retireBundle(runtime, runtimeId, hostCwd, destination))
  try { await runtime.file.stat(destination) } catch (error) { if (isMissingError(error)) return; throw error }
  const backupDir = hostJoin(runtimeId, hostCwd, '.cate')
  await mkdirp(runtime, runtimeId, hostCwd, backupDir)
  const backup = hostJoin(runtimeId, backupDir, `.skills-retired-${randomUUID()}`)
  await runtime.file.rename(destination, backup)
  publications.getStore()!.push({
    rollback: async () => {
      try { await runtime.file.rename(backup, destination) }
      catch (error) { throw new Error(`Skill rollback failed; backup retained at ${backup}`, { cause: error }) }
    },
    cleanup: () => runtime.file.remove(backup).then(() => {}),
  })
}

export interface BundleFile { relPath: string; bytes: Buffer }
export interface InstalledBundle { files: BundleFile[]; path: string; contentHash: string }
type BundleTarget = { name: string; targetId: SkillTargetId }
export function isMissingError(error: unknown): boolean {
  return (
    (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') ||
    (error instanceof Error && /ENOENT|no such file/i.test(error.message))
  )
}

export async function mkdirp(
  runtime: SkillFileHost,
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

export async function readDirectory(
  runtime: SkillFileHost,
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

export function hashBundle(files: BundleFile[]): string {
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

export function installedPath(
  runtimeId: string,
  hostCwd: string,
  entry: BundleTarget,
  root = skillsRootDir(entry.targetId, runtimeId, hostCwd),
): string {
  const slug = slugifySkillName(entry.name)
  return targetInfo(entry.targetId).layout === 'folder'
    ? hostJoin(runtimeId, root, slug)
    : hostJoin(runtimeId, root, `${slug}.md`)
}

export async function readInstalledBundle(
  runtime: SkillFileHost,
  runtimeId: string,
  hostCwd: string,
  entry: BundleTarget,
  root?: string,
): Promise<InstalledBundle | null> {
  const path = installedPath(runtimeId, hostCwd, entry, root)
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

export async function materializeBundle(
  runtime: SkillFileHost,
  runtimeId: string,
  hostCwd: string,
  entry: BundleTarget,
  files: BundleFile[],
  replace: boolean,
  root = skillsRootDir(entry.targetId, runtimeId, hostCwd),
): Promise<boolean> {
  return replaceBundle(runtime, runtimeId, hostCwd, installedPath(runtimeId, hostCwd, entry, root), files, targetInfo(entry.targetId).layout, replace, root)
}

export async function replaceBundle(
  runtime: SkillFileHost, runtimeId: string, hostCwd: string, destination: string,
  files: BundleFile[], layout: 'folder' | 'flat', replace: boolean, root: string,
): Promise<boolean> {
  if (!publications.getStore()) return withBundleTransaction(() => replaceBundle(runtime, runtimeId, hostCwd, destination, files, layout, replace, root))
  // Reject the entire input before staging or replacing a healthy installation.
  for (const file of files) skillPathSegments(file.relPath)
  const slug = destination.split(/[/\\]/).pop() ?? 'skill'
  const transactionId = randomUUID()
  const staging = layout === 'folder'
    ? hostJoin(runtimeId, hostCwd, '.cate', `.skills-mirror-stage-${slug}-${transactionId}`)
    : hostJoin(runtimeId, hostCwd, '.cate', `.skills-mirror-stage-${slug}-${transactionId}.md`)
  const backup = hostJoin(runtimeId, hostCwd, '.cate', `.skills-mirror-backup-${slug}-${transactionId}`)
  let backupHeld = false
  let published = false

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
      backupHeld = true
    }
    publications.getStore()!.push({
      rollback: async () => {
        if (published) await runtime.file.remove(destination)
        if (backupHeld) {
          try { await runtime.file.rename(backup, destination) }
          catch (error) { throw new Error(`Skill rollback failed; backup retained at ${backup}`, { cause: error }) }
        }
      },
      cleanup: async () => { if (backupHeld) await runtime.file.remove(backup) },
    })
    await runtime.file.rename(staging, destination)
    published = true
    return true
  } finally {
    try { await runtime.file.remove(staging) } catch { /* already renamed or best-effort cleanup */ }
  }
}


export function prepareBundle(files: SkillFile[], slug?: string): BundleFile[] {
  return files.map(file => {
    skillPathSegments(file.relPath)
    if (file.text === undefined && file.base64 === undefined) throw new Error(`Skill file has no content: ${file.relPath}`)
    const text = file.relPath === 'SKILL.md' && file.text !== undefined && slug ? ensureSkillName(file.text, slug) : file.text
    return { relPath: file.relPath, bytes: text !== undefined ? Buffer.from(text, 'utf8') : Buffer.from(file.base64!, 'base64') }
  })
}
export function skillFiles(files: BundleFile[]): SkillFile[] {
  return files.map(file => {
    const text = file.bytes.toString('utf8')
    return Buffer.from(text, 'utf8').equals(file.bytes) ? { relPath: file.relPath, text } : { relPath: file.relPath, base64: file.bytes.toString('base64') }
  })
}
export function fileHashes(files: BundleFile[]): Record<string, string> {
  return Object.fromEntries(files.map(file => [file.relPath, createHash('sha256').update(file.bytes).digest('hex')]))
}

/** Reconcile tracked bytes without claiming user-created or modified files.
 * Interactive installs may explicitly replace incoming files; bundled updates
 * replace only unchanged owned files. Both retire only proven-owned bytes. */
export function reconcileManagedBundle(current: BundleFile[], incoming: BundleFile[], owned: Record<string, string> = {}, overwrite = false): { files: BundleFile[]; managedFiles: Record<string, string> } {
  const currentHashes = fileHashes(current)
  const next = new Map(current.filter(file => owned[file.relPath] !== currentHashes[file.relPath]).map(file => [file.relPath, file]))
  const managedFiles: Record<string, string> = {}
  for (const file of incoming) {
    if (overwrite || !next.has(file.relPath)) {
      next.set(file.relPath, file)
      Object.assign(managedFiles, fileHashes([file]))
    } else if (owned[file.relPath]) managedFiles[file.relPath] = owned[file.relPath]
  }
  return { files: [...next.values()], managedFiles }
}
