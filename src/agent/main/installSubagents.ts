// =============================================================================
// installSubagents — one-shot install of pi's official subagent extension into
// ~/.pi/agent/ on first use. Pi auto-discovers extensions from this directory
// when its RPC process starts; no further wiring is needed on our side.
//
// The extension itself lives inside the @earendil-works/pi-coding-agent npm
// package (examples/extensions/subagent). We copy three things:
//   - extensions/subagent/{index.ts,agents.ts}  → ~/.pi/agent/extensions/subagent/
//   - agents/*.md (scout, planner, reviewer, worker, plus our additions)
//                                               → ~/.pi/agent/agents/
//   - prompts/*.md (implement, scout-and-plan, ...) → ~/.pi/agent/prompts/
//
// All copies are skip-if-exists so the user's own modifications survive.
// =============================================================================

import fs from 'fs'
import fsp from 'fs/promises'
import os from 'os'
import path from 'path'
import { app } from 'electron'
import log from '../../main/logger'
import { addAllowedRoot } from '../../main/ipc/pathValidation'

function agentDir(): string {
  return path.join(os.homedir(), '.pi', 'agent')
}

function piPackageDir(): string {
  return path.join(app.getAppPath(), 'node_modules', '@earendil-works', 'pi-coding-agent')
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

let installed = false

/** Idempotent — safe to call from AgentManager.create() on every session. */
export async function installSubagentExtension(): Promise<void> {
  // Whitelist ~/.pi/agent on every call so EditorPanel can read skill/agent
  // .md files via fs:readFile, even on app restarts.
  try { addAllowedRoot(agentDir()) } catch { /* */ }
  if (installed) return
  installed = true
  try {
    const examples = path.join(piPackageDir(), 'examples', 'extensions', 'subagent')
    if (!fs.existsSync(examples)) {
      log.warn('[installSubagents] subagent extension examples not found at %s — skipping', examples)
      return
    }
    const home = agentDir()
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
