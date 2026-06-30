// =============================================================================
// installCateAgentTools — copy the bundled cate-agent-tools extension into the Cate
// Agent's pi dir on first use, where pi auto-discovers it. Mirrors installAskUser,
// but targets the Cate Agent's OWN agent dir (pi-agent-cate-agent) — normal agent
// panels never see this extension. The tools register only when CATE_AGENT_ROLE is
// set anyway.
// =============================================================================

import path from 'path'
import { app } from 'electron'
import log from '../../main/logger'
import { hostAgentDir, hostJoin, type AgentDirVariant } from './agentDir'
import { copyFileToHost, createIdempotencyTracker, findSourceDir } from './extensionInstall'
import type { Runtime } from '../../main/runtime/types'

function sourceDir(): string | null {
  return findSourceDir([
    path.join(app.getAppPath(), 'src', 'agent', 'extensions', 'cate-agent-tools'),
    path.join(process.resourcesPath ?? '', 'cate-extensions', 'cate-agent-tools'),
  ])
}

const installed = createIdempotencyTracker()

/** Idempotent — safe to call from AgentManager.create() on every session.
 *  `cwd` is the HOST path on whichever machine pi runs. */
export async function installCateAgentToolsExtension(runtime: Runtime, cwd: string, variant: AgentDirVariant = 'cateAgent'): Promise<void> {
  const home = hostAgentDir(runtime.id, cwd, variant)
  const key = runtime.id + '\0' + home
  if (!installed.shouldInstall(key)) return
  installed.markInstalled(key)
  try {
    const src = sourceDir()
    if (!src) {
      log.warn('[installCateAgentTools] source dir not found — Cate Agent tools not installed')
      return
    }
    const destDir = hostJoin(runtime.id, home, 'extensions', 'cate-agent-tools')
    await copyFileToHost(runtime, path.join(src, 'index.ts'), destDir, 'index.ts', 'if-changed', '[installCateAgentTools]')
    await copyFileToHost(runtime, path.join(src, 'package.json'), destDir, 'package.json', 'if-changed', '[installCateAgentTools]')
  } catch (err) {
    log.warn('[installCateAgentTools] install failed: %O', err)
  }
}
