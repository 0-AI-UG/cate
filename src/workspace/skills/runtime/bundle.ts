// Skill bundles on disk: read, hash, stage and publish them atomically, with
// rollback when a transaction's later step (the manifest) fails.

import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import { createLogger } from '@kernel/log/contract'
import { ensureSkillName, skillPathSegments, slugifySkillName, type SkillFile, type SkillTargetId } from '../contract'
import { isMissingError, type SkillFiles } from './files'
import type { TargetTable } from './targets'

const log = createLogger('skills')

interface BundlePublication {
  rollback(): Promise<void>
  cleanup(): Promise<void>
}
const publications = new AsyncLocalStorage<BundlePublication[]>()

/** Keep publication backups until both bytes and their ownership metadata are
 *  committed. Nested helpers join the same operation. */
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
      try { await change.cleanup() } catch (error) { log.warn('committed transaction retained cleanup backup: %O', error) }
    }
    return result
  })
}

/** Removing a bundle is a publication too: hide it now, keep its bytes until
 *  the ownership update commits, restore it on failure. */
export async function retireBundle(files: SkillFiles, cwd: string, destination: string): Promise<void> {
  if (!publications.getStore()) return withBundleTransaction(() => retireBundle(files, cwd, destination))
  try { await files.stat(destination) } catch (error) { if (isMissingError(error)) return; throw error }
  const backupDir = path.join(cwd, '.cate')
  await mkdirp(files, cwd, backupDir)
  const backup = path.join(backupDir, `.skills-retired-${randomUUID()}`)
  await files.rename(destination, backup)
  publications.getStore()!.push({
    rollback: async () => {
      try { await files.rename(backup, destination) }
      catch (error) { throw new Error(`Skill rollback failed; backup retained at ${backup}`, { cause: error }) }
    },
    cleanup: () => files.remove(backup).then(() => {}),
  })
}

interface BundleFile { relPath: string; bytes: Buffer }
interface InstalledBundle { files: BundleFile[]; path: string; contentHash: string }
interface BundleTarget { name: string; targetId: SkillTargetId }

/** mkdir each level under `cwd` (the host may not create parents). */
export async function mkdirp(files: SkillFiles, cwd: string, targetDir: string): Promise<void> {
  const rel = targetDir.slice(cwd.length).replace(/^[/\\]+/, '')
  let current = cwd
  for (const part of rel.split(/[/\\]+/).filter(Boolean)) {
    current = path.join(current, part)
    await files.mkdir(current)
  }
}

export async function readDirectory(files: SkillFiles, dir: string, base = ''): Promise<BundleFile[]> {
  const nodes = await files.readDir(dir)
  const out: BundleFile[] = []
  for (const node of [...nodes].sort((a, b) => a.name.localeCompare(b.name))) {
    const child = path.join(dir, node.name)
    const relPath = base ? `${base}/${node.name}` : node.name
    if (node.isDirectory) {
      out.push(...await readDirectory(files, child, relPath))
    } else {
      skillPathSegments(relPath)
      out.push({ relPath, bytes: await files.readBinary(child) })
    }
  }
  return out
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

function installedPath(targets: TargetTable, cwd: string, entry: BundleTarget, root = targets.rootDirs(entry.targetId, cwd)[0]): string {
  const slug = slugifySkillName(entry.name)
  return targets.get(entry.targetId).layout === 'folder' ? path.join(root, slug) : path.join(root, `${slug}.md`)
}

export async function readInstalledBundle(
  files: SkillFiles,
  targets: TargetTable,
  cwd: string,
  entry: BundleTarget,
  root?: string,
): Promise<InstalledBundle | null> {
  const at = installedPath(targets, cwd, entry, root)
  let stat
  try {
    stat = await files.stat(at)
  } catch (error) {
    if (isMissingError(error)) return null
    throw error
  }
  const layout = targets.get(entry.targetId).layout
  if ((layout === 'folder' && !stat.isDirectory) || (layout === 'flat' && !stat.isFile)) {
    throw new Error(`Unexpected skill path type: ${at}`)
  }
  const bundle = layout === 'folder'
    ? await readDirectory(files, at)
    : [{ relPath: 'SKILL.md', bytes: await files.readBinary(at) }]
  return { files: bundle, path: at, contentHash: hashBundle(bundle) }
}

export async function materializeBundle(
  files: SkillFiles,
  targets: TargetTable,
  cwd: string,
  entry: BundleTarget,
  bundle: BundleFile[],
  replace: boolean,
  root = targets.rootDirs(entry.targetId, cwd)[0],
): Promise<boolean> {
  return replaceBundle(files, cwd, installedPath(targets, cwd, entry, root), bundle, targets.get(entry.targetId).layout, replace, root)
}

async function replaceBundle(
  files: SkillFiles, cwd: string, destination: string,
  bundle: BundleFile[], layout: 'folder' | 'flat', replace: boolean, root: string,
): Promise<boolean> {
  if (!publications.getStore()) return withBundleTransaction(() => replaceBundle(files, cwd, destination, bundle, layout, replace, root))
  // Reject the whole input before staging or replacing a healthy install.
  for (const file of bundle) skillPathSegments(file.relPath)
  const slug = destination.split(/[/\\]/).pop() ?? 'skill'
  const transactionId = randomUUID()
  const cateDir = path.join(cwd, '.cate')
  const staging = layout === 'folder'
    ? path.join(cateDir, `.skills-mirror-stage-${slug}-${transactionId}`)
    : path.join(cateDir, `.skills-mirror-stage-${slug}-${transactionId}.md`)
  const backup = path.join(cateDir, `.skills-mirror-backup-${slug}-${transactionId}`)
  let backupHeld = false
  let published = false

  await mkdirp(files, cwd, root)
  await mkdirp(files, cwd, cateDir)
  try {
    if (layout === 'folder') {
      await mkdirp(files, cwd, staging)
      for (const file of bundle) {
        const segments = skillPathSegments(file.relPath)
        if (segments.length > 1) await mkdirp(files, cwd, path.join(staging, ...segments.slice(0, -1)))
        await files.writeBinary(path.join(staging, ...segments), file.bytes)
      }
    } else {
      const skillMd = bundle.find((file) => file.relPath === 'SKILL.md')
      if (!skillMd) throw new Error('Skill is missing SKILL.md')
      await files.writeBinary(staging, skillMd.bytes)
    }

    if (!replace) {
      try {
        await files.stat(destination)
        return false
      } catch (error) {
        if (!isMissingError(error)) throw error
      }
    } else {
      await files.rename(destination, backup)
      backupHeld = true
    }
    publications.getStore()!.push({
      rollback: async () => {
        if (published) await files.remove(destination)
        if (backupHeld) {
          try { await files.rename(backup, destination) }
          catch (error) { throw new Error(`Skill rollback failed; backup retained at ${backup}`, { cause: error }) }
        }
      },
      cleanup: async () => { if (backupHeld) await files.remove(backup) },
    })
    await files.rename(staging, destination)
    published = true
    return true
  } finally {
    try { await files.remove(staging) } catch { /* already renamed */ }
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
 *  Interactive installs may replace incoming files; automatic updates replace
 *  only unchanged owned files. Both retire only proven-owned bytes. */
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
