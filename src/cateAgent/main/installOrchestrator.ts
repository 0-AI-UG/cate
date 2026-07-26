import path from 'path'
import { app } from 'electron'
import log from '../../main/logger'
import { hostCodingDir, hostJoin } from './codingDir'
import { copyFileToHost, createIdempotencyTracker, findSourceDir } from './extensionInstall'
import type { Runtime } from '../../main/runtime/types'

function sourceDir(): string | null {
  return findSourceDir([
    path.join(app.getAppPath(), 'src', 'cateAgent', 'extensions', 'cate-orchestrator'),
    path.join(process.resourcesPath ?? '', 'cate-extensions', 'cate-orchestrator'),
  ])
}

const installed = createIdempotencyTracker()

export async function installOrchestratorExtension(runtime: Runtime, cwd: string): Promise<void> {
  const home = hostCodingDir(runtime.id, cwd)
  const key = runtime.id + '\0' + home
  if (!installed.shouldInstall(key)) return
  installed.markInstalled(key)
  try {
    const src = sourceDir()
    if (!src) {
      log.warn('[installOrchestrator] source dir not found — orchestration tools not installed')
      return
    }
    const destDir = hostJoin(runtime.id, home, 'extensions', 'cate-orchestrator')
    await copyFileToHost(runtime, path.join(src, 'index.ts'), destDir, 'index.ts', 'if-changed', '[installOrchestrator]')
    await copyFileToHost(runtime, path.join(src, 'package.json'), destDir, 'package.json', 'if-changed', '[installOrchestrator]')
  } catch (err) {
    log.warn('[installOrchestrator] install failed: %O', err)
  }
}
