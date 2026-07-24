// =============================================================================
// installCanvasMode — copy the bundled cate-canvas-mode extension into a
// workspace's Cate agent directory. Mirrors the plan/ask-user installers.
// =============================================================================

import path from 'path'
import { app } from 'electron'
import log from '../../main/logger'
import { hostCodingDir, hostJoin } from './codingDir'
import { copyFileToHost, createIdempotencyTracker, findSourceDir } from './extensionInstall'
import type { Runtime } from '../../main/runtime/types'

function sourceDir(): string | null {
  return findSourceDir([
    path.join(app.getAppPath(), 'src', 'cateAgent', 'extensions', 'cate-canvas-mode'),
    path.join(process.resourcesPath ?? '', 'cate-extensions', 'cate-canvas-mode'),
  ])
}

const installed = createIdempotencyTracker()

export async function installCanvasModeExtension(runtime: Runtime, cwd: string): Promise<void> {
  const home = hostCodingDir(runtime.id, cwd)
  const key = runtime.id + '\0' + home
  if (!installed.shouldInstall(key)) return
  installed.markInstalled(key)
  try {
    const src = sourceDir()
    if (!src) {
      log.warn('[installCanvasMode] source dir not found — canvas mode extension not installed')
      return
    }
    const destDir = hostJoin(runtime.id, home, 'extensions', 'cate-canvas-mode')
    await copyFileToHost(runtime, path.join(src, 'index.ts'), destDir, 'index.ts', 'if-changed', '[installCanvasMode]')
    await copyFileToHost(runtime, path.join(src, 'package.json'), destDir, 'package.json', 'if-changed', '[installCanvasMode]')
  } catch (err) {
    log.warn('[installCanvasMode] install failed: %O', err)
  }
}
