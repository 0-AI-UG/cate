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
// <cwd>/.cate/pi-agent/):
//   - extensions/subagent/{index.ts,agents.ts}
//   - agents/*.md (scout, planner, reviewer, worker, plus our additions)
//   - prompts/*.md (implement, scout-and-plan, ...)
//
// All copies are skip-if-exists so the user's own modifications survive.
// =============================================================================

import fs from 'fs'
import fsp from 'fs/promises'
import path from 'path'
import { app } from 'electron'
import log from '../../main/logger'
import { addAllowedRoot } from '../../main/ipc/pathValidation'
import { agentDirFor } from './agentDir'

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

async function copyIfMissing(src: string, dest: string): Promise<void> {
  try {
    await fsp.access(dest)
    return // already present — leave the user's copy alone
  } catch { /* fall through */ }
  await fsp.mkdir(path.dirname(dest), { recursive: true })
  await fsp.copyFile(src, dest)
  log.info('[installSubagents] installed %s', dest)
}

async function copyDirContents(srcDir: string, destDir: string): Promise<void> {
  if (!fs.existsSync(srcDir)) return
  await fsp.mkdir(destDir, { recursive: true })
  for (const entry of await fsp.readdir(srcDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue
    await copyIfMissing(path.join(srcDir, entry.name), path.join(destDir, entry.name))
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
 */
async function stripPinnedModels(agentsDir: string): Promise<void> {
  if (!fs.existsSync(agentsDir)) return
  for (const entry of await fsp.readdir(agentsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue
    const filePath = path.join(agentsDir, entry.name)
    let content: string
    try { content = await fsp.readFile(filePath, 'utf-8') }
    catch { continue }
    if (!content.startsWith('---')) continue
    const end = content.indexOf('\n---', 3)
    if (end < 0) continue
    const frontmatter = content.slice(0, end + 4)
    if (!/^model:\s*/m.test(frontmatter)) continue
    const stripped = frontmatter.replace(/^model:\s*.*\n/m, '')
    const updated = stripped + content.slice(end + 4)
    try {
      await fsp.writeFile(filePath, updated, 'utf-8')
      log.info('[installSubagents] stripped pinned model from %s', filePath)
    } catch (err) {
      log.warn('[installSubagents] failed to update %s: %O', filePath, err)
    }
  }
}

const installed = new Set<string>()

/** Idempotent — safe to call from AgentManager.create() on every session. */
export async function installSubagentExtension(cwd: string): Promise<void> {
  const home = agentDirFor(cwd)
  // Whitelist the workspace's pi-agent dir on every call so EditorPanel can
  // read skill/agent .md files via fs:readFile, even on app restarts.
  try { addAllowedRoot(home) } catch { /* */ }
  if (installed.has(home)) return
  installed.add(home)
  try {
    const examples = subagentSourceDir()
    if (!examples) {
      log.warn('[installSubagents] subagent extension source not found — skipping')
      return
    }
    await copyIfMissing(
      path.join(examples, 'index.ts'),
      path.join(home, 'extensions', 'subagent', 'index.ts'),
    )
    await copyIfMissing(
      path.join(examples, 'agents.ts'),
      path.join(home, 'extensions', 'subagent', 'agents.ts'),
    )
    await copyDirContents(path.join(examples, 'agents'), path.join(home, 'agents'))
    await copyDirContents(path.join(examples, 'prompts'), path.join(home, 'prompts'))
    await stripPinnedModels(path.join(home, 'agents'))
  } catch (err) {
    log.warn('[installSubagents] install failed: %O', err)
  }
}
