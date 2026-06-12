// =============================================================================
// installPetTools — copy the bundled cate-pet-tools extension into the Canvas
// Pet's pi dir on first use, where pi auto-discovers it. Mirrors installAskUser,
// but targets the pet's OWN agent dir (pi-agent-pet) — normal agent panels never
// see this extension. The tools register only when CATE_PET_ROLE is set anyway.
// =============================================================================

import path from 'path'
import { app } from 'electron'
import log from '../../main/logger'
import { hostAgentDir, hostJoin, type AgentDirVariant } from './agentDir'
import { copyFileToHost, createIdempotencyTracker, findSourceDir } from './extensionInstall'
import type { Companion } from '../../main/companion/types'

function sourceDir(): string | null {
  return findSourceDir([
    path.join(app.getAppPath(), 'src', 'agent', 'extensions', 'cate-pet-tools'),
    path.join(process.resourcesPath ?? '', 'cate-extensions', 'cate-pet-tools'),
  ])
}

const installed = createIdempotencyTracker()

/** Idempotent — safe to call from AgentManager.create() on every session.
 *  `cwd` is the HOST path on whichever machine pi runs. */
export async function installPetToolsExtension(companion: Companion, cwd: string, variant: AgentDirVariant = 'pet'): Promise<void> {
  const home = hostAgentDir(companion.id, cwd, variant)
  const key = companion.id + '\0' + home
  if (!installed.shouldInstall(key)) return
  installed.markInstalled(key)
  try {
    const src = sourceDir()
    if (!src) {
      log.warn('[installPetTools] source dir not found — pet tools not installed')
      return
    }
    const destDir = hostJoin(companion.id, home, 'extensions', 'cate-pet-tools')
    await copyFileToHost(companion, path.join(src, 'index.ts'), destDir, 'index.ts', 'if-changed', '[installPetTools]')
    await copyFileToHost(companion, path.join(src, 'package.json'), destDir, 'package.json', 'if-changed', '[installPetTools]')
  } catch (err) {
    log.warn('[installPetTools] install failed: %O', err)
  }
}
