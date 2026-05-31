// =============================================================================
// agentDir — per-workspace home for the embedded pi coding agent.
//
// Pi resolves its entire config dir (extensions, sessions, settings.json,
// auth.json) from PI_CODING_AGENT_DIR when set, else ~/.pi/agent. We point it
// per-workspace at <cwd>/.cate/pi-agent so each project is self-contained and
// cate stops seeding state into the user's global pi install.
//
// Auth is the one exception: provider logins are not project-specific, so we
// keep a single shared auth.json in cate's userData and mirror it into each
// workspace dir with a copy-on-spawn + watch-and-copy-back scheme. This is
// uniform across Windows/macOS/Linux (no symlinks, no privileges, any volume).
// =============================================================================

import fs from 'fs'
import fsp from 'fs/promises'
import os from 'os'
import path from 'path'
import { app } from 'electron'
import { watch, type FSWatcher } from 'chokidar'
import log from '../../main/logger'
import { ensureCateGitignore } from '../../main/cateGitignore'

const CATE_DIR = '.cate'
const PI_AGENT_DIR = 'pi-agent'

/** Per-workspace pi config dir. Pi honours this via PI_CODING_AGENT_DIR. */
export function agentDirFor(cwd: string): string {
  return path.join(cwd, CATE_DIR, PI_AGENT_DIR)
}

/** The single shared auth.json — source of truth for provider credentials. */
export function sharedAuthPath(): string {
  return path.join(app.getPath('userData'), PI_AGENT_DIR, 'auth.json')
}

function workspaceAuthPath(cwd: string): string {
  return path.join(agentDirFor(cwd), 'auth.json')
}

/** Legacy global pi auth, used once to seed the shared file so existing users
 *  aren't logged out by the cut-over to per-workspace dirs. */
function legacyGlobalAuthPath(): string {
  return path.join(os.homedir(), '.pi', 'agent', 'auth.json')
}

async function readFileOrNull(p: string): Promise<string | null> {
  try { return await fsp.readFile(p, 'utf-8') }
  catch { return null }
}

// Serialize writes to the shared auth file so two workspaces refreshing tokens
// at the same moment can't interleave on it.
let sharedWriteQueue: Promise<void> = Promise.resolve()
function queueSharedWrite(fn: () => Promise<void>): Promise<void> {
  sharedWriteQueue = sharedWriteQueue.then(fn, fn)
  return sharedWriteQueue
}

async function ensureSharedAuth(): Promise<void> {
  const shared = sharedAuthPath()
  if (fs.existsSync(shared)) return
  await fsp.mkdir(path.dirname(shared), { recursive: true, mode: 0o700 })
  // One-time seed from the user's old global pi auth so logins carry over.
  const legacy = await readFileOrNull(legacyGlobalAuthPath())
  await fsp.writeFile(shared, legacy ?? '{}\n', 'utf-8')
  try { await fsp.chmod(shared, 0o600) } catch { /* no file modes on this platform */ }
}

async function copyAuth(from: string, to: string): Promise<void> {
  const data = await readFileOrNull(from)
  if (data == null) return
  await fsp.mkdir(path.dirname(to), { recursive: true })
  await fsp.writeFile(to, data, 'utf-8')
  try { await fsp.chmod(to, 0o600) } catch { /* */ }
}

/** Create the workspace's pi-agent dir, seed its auth.json from the shared
 *  file, and keep the dir out of version control. Returns the agent dir. */
export async function prepareAgentDir(cwd: string): Promise<string> {
  const dir = agentDirFor(cwd)
  await fsp.mkdir(dir, { recursive: true })
  await ensureSharedAuth()
  await copyAuth(sharedAuthPath(), workspaceAuthPath(cwd))
  // Sessions, settings, and the auth copy must never be committed — covered by
  // the single .cate/.gitignore (ignores everything but workspace.json).
  await ensureCateGitignore(path.join(cwd, CATE_DIR))
  return dir
}

/** Push the shared auth into a workspace copy. Called when cate's own UI changes
 *  auth so live pi processes pick up new credentials. The watcher's content
 *  check (see syncBack) absorbs the echo this write produces. */
export async function pushSharedToWorkspace(cwd: string): Promise<void> {
  await copyAuth(sharedAuthPath(), workspaceAuthPath(cwd))
}

async function syncBack(file: string): Promise<void> {
  await queueSharedWrite(async () => {
    const wsData = await readFileOrNull(file)
    if (wsData == null) return
    const sharedData = await readFileOrNull(sharedAuthPath())
    if (wsData === sharedData) return // echo of our own push, or no real change
    await fsp.mkdir(path.dirname(sharedAuthPath()), { recursive: true, mode: 0o700 })
    await fsp.writeFile(sharedAuthPath(), wsData, 'utf-8')
    try { await fsp.chmod(sharedAuthPath(), 0o600) } catch { /* */ }
    log.info('[agentDir] synced workspace auth back to shared')
  })
}

/** Watch a workspace's auth.json; when pi rewrites it (e.g. an OAuth token
 *  refresh) copy the change back to the shared file. Returns a disposer. */
export function watchWorkspaceAuth(cwd: string): () => void {
  const file = workspaceAuthPath(cwd)
  let watcher: FSWatcher | null = null
  try {
    watcher = watch(file, { ignoreInitial: true })
    const onChange = (): void => { void syncBack(file) }
    watcher.on('change', onChange)
    watcher.on('add', onChange)
  } catch (err) {
    log.warn('[agentDir] failed to watch %s: %O', file, err)
  }
  return () => { if (watcher) void watcher.close() }
}
