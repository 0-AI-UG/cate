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
//   - gated by the cliSkillInstallEnabled setting (Settings → Terminal);
//   - `cate-agent` is always seeded — it is Cate's own agent and `.cate/` is
//     already Cate-managed;
//   - every other target (claude-code, pi-native, opencode, codex, antigravity)
//     is seeded only when its tool dir (`.claude`, `.agents`, …) already exists
//     in the workspace, so repos don't grow dot-dirs for agents nobody uses
//     there. A tool dir created later is picked up on a subsequent open.
//   - each (skill, target) seeds AT MOST ONCE per workspace (a `seeded` marker
//     in skills.json), so a user uninstall sticks and an edited copy is never
//     overwritten. An already-installed copy just gets its marker.
//
// Files come from the app bundle (skills/cate-cli, shipped via extraResources)
// — not GitHub — so seeding works offline and always matches the app version.
// =============================================================================

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
import { SKILL_TARGETS, type SkillTargetId } from '../../shared/skills'
import { toolDirSegment } from './targets'
import { readManifest, readSeededMarkers, addSeededMarker, writeSkillToWorkspace } from './skillsInstaller'
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
  const targets = SKILL_TARGETS.map((t) => t.id).filter(
    (t: SkillTargetId) => !seeded.includes(`${SKILL_ID}:${t}`),
  )
  if (targets.length === 0) return

  let files: SkillFile[] | null = null
  const installed = await readManifest(runtime, runtimeId, hostCwd)
  for (const targetId of targets) {
    if (
      targetId !== 'cate-agent' &&
      !(await dirExists(runtime, hostJoin(runtimeId, hostCwd, toolDirSegment(targetId))))
    ) {
      continue
    }
    // Already installed (e.g. manually via the modal before seeding existed):
    // don't rewrite over possible user edits — just record the marker.
    if (!installed.some((m) => m.skillId === SKILL_ID && m.targetId === targetId)) {
      files ??= await readBundledFiles(srcDir)
      await writeSkillToWorkspace({ skillId: SKILL_ID, name: SKILL_NAME, targetId, cwd, files, origin: 'local' })
      log.info('[skills-seed] seeded %s for %s in %s', SKILL_NAME, targetId, hostCwd)
    }
    await addSeededMarker(runtime, runtimeId, hostCwd, `${SKILL_ID}:${targetId}`)
  }
}
