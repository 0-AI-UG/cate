// =============================================================================
// installSubagent — seed Pi's supported subagent extension and Cate's read-only
// agent definitions into every workspace-scoped Cate Agent home.
//
// The upstream example source is copied from node_modules in development and
// from electron-builder extraResources in production. Files are then written
// through the selected runtime, so local and remote workspaces behave alike.
// =============================================================================

import path from 'path'
import { app } from 'electron'
import log from '../../main/logger'
import { hostCodingDir, hostJoin } from './codingDir'
import { copyFileToHost, findSourceDir, hostFileExists } from './extensionInstall'
import type { Runtime } from '../../main/runtime/types'

const installed = new Set<string>()
const pending = new Map<string, Promise<void>>()
const CATE_AGENT_DEFINITIONS = ['scout.md', 'planner.md', 'worker.md'] as const

export async function installSubagentExtension(runtime: Runtime, cwd: string): Promise<void> {
  const home = hostCodingDir(runtime.id, cwd)
  const key = `${runtime.id}\0${home}`
  if (installed.has(key)) return
  const existing = pending.get(key)
  if (existing) return existing

  const install = (async () => {
    const runtimeSource = findSourceDir([
      path.join(
        app.getAppPath(),
        'node_modules',
        '@earendil-works',
        'pi-coding-agent',
        'examples',
        'extensions',
        'subagent',
      ),
      path.join(process.resourcesPath ?? '', 'cate-subagent-runtime'),
    ])
    const agentSource = findSourceDir([
      path.join(app.getAppPath(), 'src', 'cateAgent', 'extensions', 'cate-subagent', 'agents'),
      path.join(process.resourcesPath ?? '', 'cate-extensions', 'cate-subagent', 'agents'),
    ])
    if (!runtimeSource || !agentSource) {
      throw new Error('bundled subagent source directory not found')
    }

    // Older Cate versions installed the same managed tool under
    // extensions/subagent. Pi loads both directories and rejects the duplicate
    // `subagent` registration, so remove the obsolete Cate-managed copy before
    // installing its renamed replacement.
    const legacyExtensionDir = hostJoin(runtime.id, home, 'extensions', 'subagent')
    if (await hostFileExists(runtime, legacyExtensionDir)) {
      await runtime.file.remove(legacyExtensionDir)
      log.info('[installSubagent] removed legacy extension %s', legacyExtensionDir)
    }

    const extensionDir = hostJoin(runtime.id, home, 'extensions', 'cate-subagent')
    const agentsDir = hostJoin(runtime.id, home, 'agents')
    await copyFileToHost(
      runtime,
      path.join(runtimeSource, 'index.ts'),
      extensionDir,
      'index.ts',
      'if-changed',
      '[installSubagent]',
    )
    await copyFileToHost(
      runtime,
      path.join(runtimeSource, 'agents.ts'),
      extensionDir,
      'agents.ts',
      'if-changed',
      '[installSubagent]',
    )
    for (const agentFile of CATE_AGENT_DEFINITIONS) {
      await copyFileToHost(
        runtime,
        path.join(agentSource, agentFile),
        agentsDir,
        agentFile,
        'if-changed',
        '[installSubagent]',
      )
    }
    installed.add(key)
  })()
  pending.set(key, install)
  try {
    await install
  } catch (err) {
    log.warn('[installSubagent] install failed: %O', err)
    throw err
  } finally {
    pending.delete(key)
  }
}
