// =============================================================================
// seedCateCliSkill — auto-install the bundled cate-cli skill into a workspace
// through the SAME path the skills modal uses (writeSkillToWorkspace), so it is
// per-target, runtime-aware (local AND remote hosts) and tracked in
// <ws>/.cate/skills.json like any other install.
//
// Policy, evaluated whenever a workspace and its runtime are both present:
// at workspace open (createWorkspace), when a folder is attached to a workspace
// (updateWorkspace), and when a runtime (re)connects (replaySkillSeeds) — the
// last one is what makes remote workspaces behave like local ones, since their
// runtime connects only after create/attach.
//   - gated by the cliSkillInstallEnabled setting (Settings → CLI);
//   - `cate-agent` is always seeded — it is Cate's own agent and `.cate/` is
//     already Cate-managed;
//   - every other target (one per agent CLI that declares `skills` in
//     src/shared/agents.ts — claude-code, codex, cursor, grok, opencode,
//     pi-native) is seeded only when its tool dir (`.claude`, `.agents`, …)
//     already exists in the workspace, so repos don't grow dot-dirs for agents
//     nobody uses there. A tool dir created later is picked up on a subsequent
//     open. The loop is over SKILL_TARGETS, so a newly declared agent target is
//     seeded with no change here.
//   - a `seeded` marker in skills.json carries the CONTENT HASH of the bundle
//     it wrote (`<skillId>:<target>@<hash>`). When a newer app ships a changed
//     bundle, a copy still matching its marker's hash (unedited) is refreshed
//     in place — a stale doc actively misleads every agent that loads it. A
//     copy that no longer matches (user-edited) is never overwritten, and a
//     user uninstall (manifest entry gone, marker kept) sticks across versions.
//     Pre-hash markers can't distinguish an edit from an old bundle; they get
//     one migration refresh, then carry hashes like everything else.
//
// Files come from the app bundle (skills/cate-cli, shipped via extraResources)
// — not GitHub — so seeding works offline and always matches the app version.
// =============================================================================

import crypto from 'crypto'
import fs from 'fs'
import fsp from 'fs/promises'
import path from 'path'
import { app } from 'electron'
import log from '../../main/logger'
import { getSetting } from '../../main/settingsFile'
import { parseLocator } from '../../main/runtime/locator'
import { runtimes } from '../../main/runtime/runtimeManager'
import { hostJoin } from '../../agent/main/agentDir'
import type { Runtime } from '../../main/runtime/types'
import { SKILL_TARGETS, slugifySkillName, type SkillTargetId } from '../../shared/skills'
import { targetInfo, toolDirSegment } from './targets'
import { ensureSkillName } from './frontmatter'
import { readManifest, readSeededMarkers, setSeededMarker, writeSkillToWorkspace, readWorkspaceSkillFiles } from './skillsInstaller'
import type { SkillFile } from './githubCrawl'

// Matches the registry entry (registry/skills-index.json), so a modal install
// and a seeded install are the same skill to the manifest.
const SKILL_ID = 'cate/cate-cli'
const SKILL_NAME = 'cate-cli'

/** Source dir of the bundled skill: dev path (repo skills/ on disk) first, then
 *  the packaged extraResources copy — same resolution as installBundledSkill. */
function bundledSkillDir(): string | null {
  const candidates = [
    path.join(app.getAppPath(), 'skills', SKILL_NAME),
    path.join(process.resourcesPath ?? '', 'skills', SKILL_NAME),
  ]
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c
  }
  return null
}

/** Read the bundled skill's files as SkillFile[]. Skill bundles are text
 *  (SKILL.md + optional companions) — read as UTF-8. */
async function readBundledFiles(dir: string, base = ''): Promise<SkillFile[]> {
  const out: SkillFile[] = []
  for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name
    const abs = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...(await readBundledFiles(abs, rel)))
    } else if (entry.isFile()) {
      out.push({ relPath: rel, text: await fsp.readFile(abs, 'utf8') })
    }
  }
  return out
}

async function dirExists(runtime: Runtime, hostPath: string): Promise<boolean> {
  try {
    return (await runtime.file.stat(hostPath)).isDirectory
  } catch {
    return false
  }
}

/** What writeSkillToWorkspace would actually install for a target: single-file
 *  layouts keep only SKILL.md, and SKILL.md gets the same frontmatter-name
 *  normalization — so a hash of this compares byte-equal against a read-back of
 *  an unedited install. */
function expectedInstall(files: SkillFile[], targetId: SkillTargetId): SkillFile[] {
  const slug = slugifySkillName(SKILL_NAME)
  const withName = (f: SkillFile): SkillFile =>
    f.relPath === 'SKILL.md' && f.text != null ? { relPath: f.relPath, text: ensureSkillName(f.text, slug) } : f
  if (targetInfo(targetId).layout !== 'folder') {
    const md = files.find((f) => f.relPath === 'SKILL.md')
    return md ? [withName(md)] : []
  }
  return files.map(withName)
}

/** Order-independent content hash of a skill install (short — it only has to
 *  distinguish bundle versions, not resist collisions). */
function hashFiles(files: SkillFile[]): string {
  const h = crypto.createHash('sha256')
  for (const f of [...files].sort((a, b) => a.relPath.localeCompare(b.relPath))) {
    h.update(f.relPath)
    h.update('\0')
    h.update(f.text ?? f.base64 ?? '')
    h.update('\0')
  }
  return h.digest('hex').slice(0, 12)
}

/** Seed the bundled cate-cli skill into a workspace. Best effort and NEVER
 *  rejects (safe to call fire-and-forget at workspace open) — a failed target
 *  is retried on the next open or runtime connect, since no marker is written
 *  for it. */
export async function seedCateCliSkill(cwd: string): Promise<void> {
  try {
    await seed(cwd)
  } catch (err) {
    log.warn('[skills-seed] seeding %s failed for %s: %O', SKILL_NAME, cwd, err)
  }
}

async function seed(cwd: string): Promise<void> {
  if (getSetting('cliSkillInstallEnabled') !== true) return
  const { runtimeId, path: hostCwd } = parseLocator(cwd)
  if (!hostCwd) return

  let runtime: Runtime
  try {
    runtime = runtimes.resolve(runtimeId)
  } catch {
    return // runtime not registered yet — the runtime-connect replay retries
  }

  const srcDir = bundledSkillDir()
  if (!srcDir) {
    log.warn('[skills-seed] bundled %s dir not found — nothing seeded', SKILL_NAME)
    return
  }

  const seeded = await readSeededMarkers(runtime, runtimeId, hostCwd)
  const installed = await readManifest(runtime, runtimeId, hostCwd)
  const bundled = await readBundledFiles(srcDir)

  for (const target of SKILL_TARGETS) {
    const targetId = target.id
    const base = `${SKILL_ID}:${targetId}`
    const marker = seeded.find((m) => m === base || m.startsWith(`${base}@`))
    const expectedHash = hashFiles(expectedInstall(bundled, targetId))
    const versioned = `${base}@${expectedHash}`
    if (marker === versioned) continue // seeded and current — the common case

    const entry = installed.find((m) => m.skillId === SKILL_ID && m.targetId === targetId)
    const write = async (): Promise<void> => {
      await writeSkillToWorkspace({ skillId: SKILL_ID, name: SKILL_NAME, targetId, cwd, files: bundled, origin: 'local' })
      log.info('[skills-seed] seeded %s for %s in %s', SKILL_NAME, targetId, hostCwd)
    }

    if (marker !== undefined) {
      // Seeded before, by an older bundle — this pass is only about refreshing.
      if (!entry) {
        // The user uninstalled it; that sticks. Move the marker forward so this
        // (and every later) version stops re-checking.
        await setSeededMarker(runtime, runtimeId, hostCwd, versioned)
        continue
      }
      const installedHash = hashFiles(await readWorkspaceSkillFiles(runtime, runtimeId, hostCwd, targetId, entry.name))
      if (installedHash !== expectedHash) {
        const priorHash = marker.includes('@') ? marker.slice(base.length + 1) : null
        if (priorHash !== null && installedHash !== priorHash) {
          // Edited since the last seed — the user's copy wins. Keep the old
          // marker so the next pass re-checks (a revert to the seeded bytes
          // starts refreshing again).
          continue
        }
        // An unedited copy of an older bundle — or a pre-hash install we can't
        // tell apart from an edit, where refreshing wins: a stale doc actively
        // misleads every agent that loads it.
        await write()
      }
      await setSeededMarker(runtime, runtimeId, hostCwd, versioned)
      continue
    }

    // Never seeded here: cate-agent always, other targets only once their tool
    // dir exists (a dir created later is picked up on a subsequent open).
    if (
      targetId !== 'cate-agent' &&
      !(await dirExists(runtime, hostJoin(runtimeId, hostCwd, toolDirSegment(targetId))))
    ) {
      continue
    }
    // Already installed (e.g. manually via the modal before seeding existed):
    // don't rewrite over possible user edits — just record the marker.
    if (!entry) await write()
    await setSeededMarker(runtime, runtimeId, hostCwd, versioned)
  }
}
