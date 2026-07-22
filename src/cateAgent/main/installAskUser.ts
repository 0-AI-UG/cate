// =============================================================================
// installAskUser — copy the bundled cate-ask-user extension into a workspace's
// cate-agent extensions dir on first use, where pi auto-discovers it. Mirrors
// installPlanMode exactly (same dev/prod source resolution, same runtime-aware
// copy-if-changed semantics so a shipped update reaches hosts with an older copy).
// =============================================================================

import path from 'path'
import { app } from 'electron'
import log from '../../main/logger'
import { hostCodingDir, hostJoin } from './codingDir'
import { copyFileToHost, createIdempotencyTracker, findSourceDir } from './extensionInstall'
import type { Runtime } from '../../main/runtime/types'

/** Source dir of the bundled extension. Dev path first (src/ on disk), then the
 *  production extraResources copy. */
function sourceDir(): string | null {
  return findSourceDir([
    path.join(app.getAppPath(), 'src', 'cateAgent', 'extensions', 'cate-ask-user'),
    path.join(process.resourcesPath ?? '', 'cate-extensions', 'cate-ask-user'),
  ])
}

// Keyed on runtimeId + host path so the same host path on different runtimes
// doesn't collide.
const installed = createIdempotencyTracker()

/** Idempotent — safe to call from CodingManager.create() on every session.
 *  `cwd` is the HOST path on whichever machine pi runs. */
export async function installAskUserExtension(runtime: Runtime, cwd: string): Promise<void> {
  const home = hostCodingDir(runtime.id, cwd)
  const key = runtime.id + '\0' + home
  if (!installed.shouldInstall(key)) return
  installed.markInstalled(key)
  try {
    const src = sourceDir()
    if (!src) {
      log.warn('[installAskUser] source dir not found — ask_user extension not installed')
      return
    }
    const destDir = hostJoin(runtime.id, home, 'extensions', 'cate-ask-user')
    await copyFileToHost(runtime, path.join(src, 'index.ts'), destDir, 'index.ts', 'if-changed', '[installAskUser]')
    await copyFileToHost(runtime, path.join(src, 'package.json'), destDir, 'package.json', 'if-changed', '[installAskUser]')
  } catch (err) {
    log.warn('[installAskUser] install failed: %O', err)
  }
}
