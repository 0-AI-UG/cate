// =============================================================================
// installCateControl - copy the bundled cate-control extension into a
// workspace's pi-agent extensions dir, where pi auto-discovers it.
//
// Source lives in our own tree at src/agent/extensions/cate-control/. Pi
// loads .ts directly via jiti, so we just ship the raw .ts and .json files.
//
// Dev:  src/ is on disk under app.getAppPath().
// Prod: src/agent/extensions/cate-control/ is copied into resources via
//       electron-builder.yml `extraResources`, so we resolve from
//       process.resourcesPath there.
//
// Refresh-on-change (NOT skip-if-exists): the extension's tool/action protocol
// is tightly coupled to the renderer dispatcher (src/agent/renderer/cateControl
// + cateExecutors). A stale installed copy makes the agent emit action names the
// renderer no longer handles ("Unknown or unimplemented action"), so the bundled
// copy is authoritative and is rewritten whenever its bytes differ from the
// installed copy. (Previously skip-if-exists, which silently broke the feature
// after any extension update - dev or app upgrade.)
// =============================================================================

import fs from 'fs'
import fsp from 'fs/promises'
import path from 'path'
import { app } from 'electron'
import log from '../../main/logger'
import { agentDirFor } from './agentDir'

const installed = new Set<string>()

/** Source dir of the bundled extension. Tries dev path first (src/ on disk),
 *  then production extraResources copy. */
function sourceDir(): string | null {
  const candidates = [
    path.join(app.getAppPath(), 'src', 'agent', 'extensions', 'cate-control'),
    path.join(process.resourcesPath ?? '', 'cate-extensions', 'cate-control'),
  ]
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c
  }
  return null
}

/** Write `src` → `dest` when the destination is missing or its bytes differ.
 *  Keeps the installed extension in lock-step with the bundled source so the
 *  agent never emits a stale action the renderer dispatcher can't handle. */
export async function copyIfChanged(src: string, dest: string): Promise<void> {
  const srcData = await fsp.readFile(src)
  try {
    const destData = await fsp.readFile(dest)
    if (destData.equals(srcData)) return // up to date - nothing to do
  } catch { /* missing - fall through to write */ }
  await fsp.mkdir(path.dirname(dest), { recursive: true })
  await fsp.writeFile(dest, srcData)
  log.info('[installCateControl] installed/updated %s', dest)
}

/** Idempotent - safe to call from AgentManager.create() on every session. */
export async function installCateControlExtension(cwd: string): Promise<void> {
  const home = agentDirFor(cwd)
  if (installed.has(home)) return
  installed.add(home)
  try {
    const src = sourceDir()
    if (!src) {
      log.warn('[installCateControl] source dir not found - cate-control not installed')
      return
    }
    const destDir = path.join(home, 'extensions', 'cate-control')
    await copyIfChanged(path.join(src, 'index.ts'), path.join(destDir, 'index.ts'))
    await copyIfChanged(path.join(src, 'package.json'), path.join(destDir, 'package.json'))
  } catch (err) {
    log.warn('[installCateControl] install failed: %O', err)
  }
}
