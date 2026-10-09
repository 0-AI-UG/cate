// Seeding bundled skills into a workspace through the same install path as
// any other skill, tracked in `.cate/skills.json`.
//
// Policy, per bundled skill and target:
//   - a target is seeded only once its tool dir (`.claude`, `.codex`) exists,
//     so repos don't grow dot-dirs for agents nobody uses there;
//   - a `seeded` marker carries the content hash of the bundle it wrote. A copy
//     still matching its marker (unedited) is refreshed when the bundle
//     changes; an edited copy is never overwritten; an uninstall (manifest row
//     gone, marker kept) sticks. Hash-less markers get one refresh.

import { createHash } from 'node:crypto'
import type { Logger } from '@kernel/log/contract'
import { slugifySkillName, type SkillFile, type SkillTargetId } from '../contract'
import { prepareBundle, skillFiles } from './bundle'
import { BUNDLED_SOURCE_ID, readBundledSkill } from './bundled'
import type { SkillFiles, WithDirs } from './files'
import type { SkillInstaller } from './installer'
import type { TargetTable } from './targets'

export interface SkillSeederDeps {
  files: SkillFiles
  targets: TargetTable
  installer: SkillInstaller
  withDirs: WithDirs
  bundledSkillsDir: string | undefined
  log: Logger
}

async function dirExists(files: SkillFiles, dir: string): Promise<boolean> {
  try { return (await files.stat(dir)).isDirectory } catch { return false }
}

/** Order-independent short hash of what an install writes. */
function hashSkillFiles(files: SkillFile[]): string {
  const h = createHash('sha256')
  for (const f of [...files].sort((a, b) => a.relPath.localeCompare(b.relPath))) {
    h.update(f.relPath)
    h.update('\0')
    h.update(f.text ?? f.base64 ?? '')
    h.update('\0')
  }
  return h.digest('hex').slice(0, 12)
}

export function createSkillSeeder(deps: SkillSeederDeps) {
  const { files, targets, installer, withDirs, log } = deps

  /** What an install writes for a target: flat layouts keep only SKILL.md,
   *  and SKILL.md gets its frontmatter name, so this hashes equal to a
   *  read-back of an unedited install. */
  function expectedInstall(bundled: SkillFile[], name: string, targetId: SkillTargetId): SkillFile[] {
    const prepared = skillFiles(prepareBundle(bundled, slugifySkillName(name)))
    return targets.get(targetId).layout === 'folder' ? prepared : prepared.filter((file) => file.relPath === 'SKILL.md')
  }

  async function readBundled(name: string): Promise<SkillFile[]> {
    if (!deps.bundledSkillsDir) throw new Error('No bundled skills in this runtime')
    return readBundledSkill(files, deps.bundledSkillsDir, name)
  }

  const skillIdOf = (name: string) => `${BUNDLED_SOURCE_ID}/${slugifySkillName(name)}`

  async function seedOne(cwd: string, name: string): Promise<void> {
    const skillId = skillIdOf(name)
    const bundled = await readBundled(name)
    const seeded = await installer.readSeededMarkers(cwd)
    const installed = await installer.readManifest(cwd)

    for (const target of targets.list) {
      const targetId = target.id
      const base = `${skillId}:${targetId}`
      const marker = seeded.find((m) => m === base || m.startsWith(`${base}@`))
      const expectedHash = hashSkillFiles(expectedInstall(bundled, name, targetId))
      const versioned = `${base}@${expectedHash}`
      if (marker === versioned) continue

      const entry = installed.find((m) => m.skillId === skillId && m.targetId === targetId)
      const write = async (): Promise<void> => {
        await installer.writeSkill({ skillId, name, targetId, cwd, files: bundled })
        log.info('seeded %s for %s in %s', name, targetId, cwd)
      }

      if (marker !== undefined) {
        if (!entry) {
          // The user uninstalled it; that sticks. Move the marker forward.
          await installer.setSeededMarker(cwd, versioned)
          continue
        }
        const installedHash = hashSkillFiles(await installer.readWorkspaceSkillFiles(cwd, targetId, entry.name))
        if (installedHash !== expectedHash) {
          const priorHash = marker.includes('@') ? marker.slice(base.length + 1) : null
          // Edited since the last seed: the user's copy wins and the old marker
          // stays, so a revert to the seeded bytes starts refreshing again.
          if (priorHash !== null && installedHash !== priorHash) continue
          await write()
        }
        await installer.setSeededMarker(cwd, versioned)
        continue
      }

      if (!(await dirExists(files, targets.toolDir(targetId, cwd)))) continue
      // Already installed by hand: don't write over possible edits.
      if (!entry) await write()
      await installer.setSeededMarker(cwd, versioned)
    }
  }

  /** Seeds every named bundled skill. Never rejects: a failed target has no
   *  marker and is retried next time. */
  async function seed(cwd: string, names: readonly string[]): Promise<void> {
    for (const name of names) {
      try {
        await withDirs([cwd], () => seedOne(cwd, name))
      } catch (err) {
        log.warn('seeding %s failed for %s: %O', name, cwd, err)
      }
    }
  }

  /** Replaces Cate-managed copies with the current bundle, overwriting edits,
   *  in every target that has it installed or whose tool dir exists. */
  function reinstall(cwd: string, name: string): Promise<number> {
    return withDirs([cwd], async () => {
      const skillId = skillIdOf(name)
      const bundled = await readBundled(name)
      const installed = await installer.readManifest(cwd)
      let count = 0
      for (const target of targets.list) {
        const targetId = target.id
        const existing = installed.some((entry) => entry.skillId === skillId && entry.targetId === targetId)
        if (!existing && !(await dirExists(files, targets.toolDir(targetId, cwd)))) continue
        await installer.writeSkill({ skillId, name, targetId, cwd, files: bundled })
        await installer.setSeededMarker(cwd, `${skillId}:${targetId}@${hashSkillFiles(expectedInstall(bundled, name, targetId))}`)
        count += 1
      }
      return count
    })
  }

  return { seed, reinstall }
}
