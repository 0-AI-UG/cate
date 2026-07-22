import path from 'path'
import { app } from 'electron'
import log from '../../main/logger'
import { hostCodingDir, hostJoin } from './codingDir'
import { copyFileToHost, createIdempotencyTracker, findSourceDir } from './extensionInstall'
import type { Runtime } from '../../main/runtime/types'

function sourceDir(): string | null {
  return findSourceDir([
    path.join(app.getAppPath(), 'src', 'cateAgent', 'extensions', 'cate-engineering-task'),
    path.join(process.resourcesPath ?? '', 'cate-extensions', 'cate-engineering-task'),
  ])
}

const installed = createIdempotencyTracker()

export async function installEngineeringTaskExtension(runtime: Runtime, cwd: string): Promise<void> {
  const home = hostCodingDir(runtime.id, cwd)
  const key = `${runtime.id}\0${home}`
  if (!installed.shouldInstall(key)) return
  installed.markInstalled(key)
  try {
    const source = sourceDir()
    if (!source) {
      log.warn('[installEngineeringTask] source dir not found')
      return
    }
    const destination = hostJoin(runtime.id, home, 'extensions', 'cate-engineering-task')
    await copyFileToHost(runtime, path.join(source, 'index.ts'), destination, 'index.ts', 'if-changed', '[installEngineeringTask]')
    await copyFileToHost(runtime, path.join(source, 'package.json'), destination, 'package.json', 'if-changed', '[installEngineeringTask]')
  } catch (error) {
    log.warn('[installEngineeringTask] install failed: %O', error)
  }
}
