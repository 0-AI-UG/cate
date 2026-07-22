// =============================================================================
// installPlanMode — copy the bundled cate-plan-mode extension into a
// workspace's cate-agent extensions dir on first use, where pi auto-discovers it.
//
// Source lives in our own tree at src/cateAgent/extensions/cate-plan-mode/. Pi
// loads .ts directly via jiti, so we just ship the raw .ts and .json files.
//
// Dev:  src/ is on disk under app.getAppPath().
// Prod: src/cateAgent/extensions/cate-plan-mode/ is copied into resources via
//       electron-builder.yml `extraResources`, so we resolve from
//       process.resourcesPath there.
//
// The SOURCE bundle is always read locally with node fs (it ships inside the
// app). Each DESTINATION is written THROUGH the runtime (local fs for the
// local runtime, the daemon for a remote one), so remote workspaces are
// seeded too. The host copy is overwritten only when it differs from the
// bundled source, so shipped updates reach hosts that already have an older
// copy without rewriting on every launch.
// =============================================================================

import path from 'path'
import { app } from 'electron'
import log from '../../main/logger'
import { hostCodingDir, hostJoin, type CodingDirVariant } from './codingDir'
import { copyFileToHost, createIdempotencyTracker, findSourceDir } from './extensionInstall'
import type { Runtime } from '../../main/runtime/types'

/** Source dir of the bundled extension. Tries dev path first (src/ on disk),
 *  then production extraResources copy. */
function sourceDir(): string | null {
  return findSourceDir([
    path.join(app.getAppPath(), 'src', 'cateAgent', 'extensions', 'cate-plan-mode'),
    path.join(process.resourcesPath ?? '', 'cate-extensions', 'cate-plan-mode'),
  ])
}

/** Copy a single source file (read locally) to a host destination, overwriting
 *  only when the host copy differs from the bundled source. This is a
 *  Cate-managed extension, so the bundled version is authoritative — comparing
 *  first means we still skip the write when nothing changed (the common case),
 *  but a shipped update reliably reaches hosts that already have an older copy. */
async function copyIfChanged(
  runtime: Runtime,
  src: string,
  destDir: string,
  destName: string,
): Promise<void> {
  await copyFileToHost(runtime, src, destDir, destName, 'if-changed', '[installPlanMode]')
}

// Keyed on runtimeId + host path so the same host path on different runtimes
// doesn't collide.
const installed = createIdempotencyTracker()

/** Idempotent — safe to call from CodingManager.create() on every session.
 *  `cwd` is the HOST path on whichever machine pi runs (local fs path for the
 *  local runtime, POSIX path on a remote host). */
export async function installPlanModeExtension(
  runtime: Runtime,
  cwd: string,
  variant: CodingDirVariant = 'default',
): Promise<void> {
  const home = hostCodingDir(runtime.id, cwd, variant)
  const key = runtime.id + '\0' + home
  if (!installed.shouldInstall(key)) return
  installed.markInstalled(key)
  try {
    const src = sourceDir()
    if (!src) {
      log.warn('[installPlanMode] source dir not found — plan mode extension not installed')
      return
    }
    const destDir = hostJoin(runtime.id, home, 'extensions', 'cate-plan-mode')
    await copyIfChanged(runtime, path.join(src, 'index.ts'), destDir, 'index.ts')
    await copyIfChanged(runtime, path.join(src, 'package.json'), destDir, 'package.json')
  } catch (err) {
    log.warn('[installPlanMode] install failed: %O', err)
  }
}
