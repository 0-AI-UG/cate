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
// app). Each DESTINATION is written THROUGH the runtime (local fs for the
// local runtime, the daemon for a remote one), so remote workspaces are
// seeded too. All copies are skip-if-exists so the user's own modifications on
// the host survive.
// =============================================================================

import fs from 'fs'
import fsp from 'fs/promises'
import path from 'path'
import { app } from 'electron'
import log from '../../main/logger'
import { hostAgentDir, hostJoin } from './agentDir'
import { copyFileToHost, createIdempotencyTracker, findSourceDir } from './extensionInstall'
import type { Runtime } from '../../main/runtime/types'

/** Source dir of the vendored subagent extension. Tries the dev path first
 *  (src/ on disk), then the production extraResources copy. Mirrors
 *  installPlanMode.sourceDir(). */
function subagentSourceDir(): string | null {
  return findSourceDir([
    path.join(app.getAppPath(), 'src', 'agent', 'extensions', 'subagent'),
    path.join(process.resourcesPath ?? '', 'cate-extensions', 'subagent'),
  ])
}

/** Copy a single source file (read locally) to a host destination, skipping
 *  when the host already has it so a user's modified copy is never overwritten. */
async function copyIfMissing(
  runtime: Runtime,
  src: string,
  destDir: string,
  destName: string,
): Promise<void> {
  await copyFileToHost(runtime, src, destDir, destName, 'if-missing', '[installSubagents]')
}

/** Copy every regular file under `srcDir` (local) into `destDir` (host). */
async function copyDirContents(
  runtime: Runtime,
  srcDir: string,
  destDir: string,
): Promise<void> {
  if (!fs.existsSync(srcDir)) return
  for (const entry of await fsp.readdir(srcDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue
    await copyIfMissing(runtime, path.join(srcDir, entry.name), destDir, entry.name)
  }
}

// Keyed on runtimeId + host path so the same host path on different runtimes
// (or the same path locally and remotely) doesn't collide.
const installed = createIdempotencyTracker()

/** Idempotent — safe to call from AgentManager.create() on every session.
 *  `cwd` is the HOST path on whichever machine pi runs (local fs path for the
 *  local runtime, POSIX path on a remote host). */
export async function installSubagentExtension(runtime: Runtime, cwd: string): Promise<void> {
  const home = hostAgentDir(runtime.id, cwd)
  const key = runtime.id + '\0' + home
  if (!installed.shouldInstall(key)) return
  installed.markInstalled(key)
  try {
    const examples = subagentSourceDir()
    if (!examples) {
      log.warn('[installSubagents] subagent extension source not found — skipping')
      return
    }
    const extDir = hostJoin(runtime.id, home, 'extensions', 'subagent')
    await copyIfMissing(runtime, path.join(examples, 'index.ts'), extDir, 'index.ts')
    await copyIfMissing(runtime, path.join(examples, 'agents.ts'), extDir, 'agents.ts')
    const agentsDir = hostJoin(runtime.id, home, 'agents')
    await copyDirContents(runtime, path.join(examples, 'agents'), agentsDir)
    await copyDirContents(
      runtime,
      path.join(examples, 'prompts'),
      hostJoin(runtime.id, home, 'prompts'),
    )
  } catch (err) {
    log.warn('[installSubagents] install failed: %O', err)
  }
}
