// =============================================================================
// installSubagents — one-shot install of pi's official subagent extension into
// a workspace's pi-agent dir on first use. Pi auto-discovers extensions from
// this directory when its RPC process starts; no further wiring is needed.
//
// We vendor pi's subagent extension into our own tree at
// src/agent/extensions/subagent/ (copied from the pi-coding-agent npm package's
// examples/extensions/subagent) and ship it via electron-builder.yml
// `extraResources` into resources/cate-extensions/subagent — the same way
// cate-plan-mode ships (see installPlanMode). electron-builder's default file
// filter strips node_modules `examples/` dirs at pack time, so we can't rely on
// the npm copy in packaged builds. We copy three things (relative to
// <cwd>/.cate/pi-agent/ on the host that runs pi):
//   - extensions/subagent/{index.ts,agents.ts}
//   - agents/*.md (scout, planner, reviewer, worker, plus our additions)
//   - prompts/*.md (implement, scout-and-plan, ...)
//
// The SOURCE bundle is always read locally with node fs (it ships inside the
// app). Each DESTINATION is written THROUGH the companion (local fs for the
// local companion, the daemon for a remote one), so remote workspaces are
// seeded too. All copies are skip-if-exists so the user's own modifications on
// the host survive.
// =============================================================================

import fs from 'fs'
import fsp from 'fs/promises'
import path from 'path'
import { app } from 'electron'
import log from '../../main/logger'
import { addAllowedRoot } from '../../main/ipc/pathValidation'
import { hostAgentDir, hostJoin } from './agentDir'
import { LOCAL_COMPANION_ID } from '../../main/companion/locator'
import type { Companion } from '../../main/companion/types'

/** Source dir of the vendored subagent extension. Tries the dev path first
 *  (src/ on disk), then the production extraResources copy. Mirrors
 *  installPlanMode.sourceDir(). */
function subagentSourceDir(): string | null {
  const candidates = [
    path.join(app.getAppPath(), 'src', 'agent', 'extensions', 'subagent'),
    path.join(process.resourcesPath ?? '', 'cate-extensions', 'subagent'),
  ]
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c
  }
  return null
}

/** True when the host already has a file/dir at `hostPath`. */
async function hostExists(companion: Companion, hostPath: string): Promise<boolean> {
  try {
    await companion.file.stat(hostPath)
    return true
  } catch {
    return false
  }
}

/** Copy a single source file (read locally) to a host destination, skipping
 *  when the host already has it so a user's modified copy is never overwritten. */
async function copyIfMissing(
  companion: Companion,
  src: string,
  destDir: string,
  destName: string,
): Promise<void> {
  const dest = hostJoin(companion.id, destDir, destName)
  if (await hostExists(companion, dest)) return // leave the user's copy alone
  let contents: string
  try { contents = await fsp.readFile(src, 'utf-8') }
  catch { return } // source missing — nothing to copy
  await companion.file.mkdir(destDir)
  await companion.file.writeFile(dest, contents)
  log.info('[installSubagents] installed %s', dest)
}

/** Copy every regular file under `srcDir` (local) into `destDir` (host). */
async function copyDirContents(
  companion: Companion,
  srcDir: string,
  destDir: string,
): Promise<void> {
  if (!fs.existsSync(srcDir)) return
  for (const entry of await fsp.readdir(srcDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue
    await copyIfMissing(companion, path.join(srcDir, entry.name), destDir, entry.name)
  }
}

/**
 * Pi's default subagent .md files pin `model: claude-haiku-4-5` etc. in their
 * frontmatter. When the user has only signed in to another provider (DeepSeek,
 * OpenAI, …), every subagent invocation fails with "No API key found for
 * anthropic". Stripping the model line makes pi fall back to the parent
 * session's model, so subagents inherit whatever the user has connected.
 *
 * We also migrate already-installed files in case the user has an older copy.
 * Operates on the host via the companion so remote copies are migrated too.
 */
async function stripPinnedModels(companion: Companion, agentsDir: string): Promise<void> {
  let entries
  try { entries = await companion.file.readDir(agentsDir) }
  catch { return }
  for (const entry of entries) {
    if (entry.isDirectory || !entry.name.endsWith('.md')) continue
    const filePath = hostJoin(companion.id, agentsDir, entry.name)
    let content: string
    try { content = await companion.file.readFile(filePath) }
    catch { continue }
    if (!content.startsWith('---')) continue
    const end = content.indexOf('\n---', 3)
    if (end < 0) continue
    const frontmatter = content.slice(0, end + 4)
    if (!/^model:\s*/m.test(frontmatter)) continue
    const stripped = frontmatter.replace(/^model:\s*.*\n/m, '')
    const updated = stripped + content.slice(end + 4)
    try {
      await companion.file.writeFile(filePath, updated)
      log.info('[installSubagents] stripped pinned model from %s', filePath)
    } catch (err) {
      log.warn('[installSubagents] failed to update %s: %O', filePath, err)
    }
  }
}

// Keyed on companionId + host path so the same host path on different companions
// (or the same path locally and remotely) doesn't collide.
const installed = new Set<string>()

/** Idempotent — safe to call from AgentManager.create() on every session.
 *  `cwd` is the HOST path on whichever machine pi runs (local fs path for the
 *  local companion, POSIX path on a remote host). */
export async function installSubagentExtension(companion: Companion, cwd: string): Promise<void> {
  const home = hostAgentDir(companion.id, cwd)
  // Whitelist the workspace's pi-agent dir on every call so EditorPanel can
  // read skill/agent .md files via fs:readFile. Only meaningful for the local
  // companion (a local fs path); remote files are validated by the daemon.
  if (companion.id === LOCAL_COMPANION_ID) {
    try { addAllowedRoot(home) } catch { /* */ }
  }
  const key = companion.id + '\0' + home
  if (installed.has(key)) return
  installed.add(key)
  try {
    const examples = subagentSourceDir()
    if (!examples) {
      log.warn('[installSubagents] subagent extension source not found — skipping')
      return
    }
    const extDir = hostJoin(companion.id, home, 'extensions', 'subagent')
    await copyIfMissing(companion, path.join(examples, 'index.ts'), extDir, 'index.ts')
    await copyIfMissing(companion, path.join(examples, 'agents.ts'), extDir, 'agents.ts')
    const agentsDir = hostJoin(companion.id, home, 'agents')
    await copyDirContents(companion, path.join(examples, 'agents'), agentsDir)
    await copyDirContents(
      companion,
      path.join(examples, 'prompts'),
      hostJoin(companion.id, home, 'prompts'),
    )
    await stripPinnedModels(companion, agentsDir)
  } catch (err) {
    log.warn('[installSubagents] install failed: %O', err)
  }
}
