// =============================================================================
// agentDir — per-workspace home for the pi coding agent, seeded THROUGH the
// companion so it works whether the workspace is local or on a remote host.
//
// Pi resolves its config dir (extensions, sessions, settings.json, auth.json)
// from PI_CODING_AGENT_DIR; we point it per-workspace at <cwd>/.cate/pi-agent on
// whichever host pi runs. Provider logins aren't project-specific, so a single
// shared auth.json lives in cate's userData (always local) and is mirrored into
// each workspace's dir via companion.file (local fs for the local companion, or
// the daemon for a remote one) with a copy-on-spawn + watch-and-copy-back scheme.
// =============================================================================

import fs from 'fs'
import fsp from 'fs/promises'
import os from 'os'
import path from 'path'
import { app } from 'electron'
import log from '../../main/logger'
import { writeTextAtomic } from '../../main/writeJsonAtomic'
import { LOCAL_COMPANION_ID } from '../../main/companion/locator'
import { sharedAuthWriteQueue } from './writeQueue'
import type { Companion } from '../../main/companion/types'

const CATE_DIR = '.cate'
export const PI_AGENT_DIR = 'pi-agent'

/** Per-workspace pi config dir on the LOCAL machine (native path). Used by the
 *  local skill-file IPC; companion-aware code uses hostAgentDir(). */
export function agentDirFor(cwd: string): string {
  return path.join(cwd, CATE_DIR, PI_AGENT_DIR)
}

/** Per-workspace pi config dir on the host that runs pi. Remote hosts are POSIX,
 *  the local machine uses native separators. */
export function hostAgentDir(companionId: string, hostCwd: string): string {
  const join = companionId === LOCAL_COMPANION_ID ? path.join : path.posix.join
  return join(hostCwd, CATE_DIR, PI_AGENT_DIR)
}

export function hostJoin(companionId: string, ...segs: string[]): string {
  return (companionId === LOCAL_COMPANION_ID ? path.join : path.posix.join)(...segs)
}

/** Pi maps a host cwd (e.g. `/Users/anton/Dev/cate`) to a sessions subdir named
 *  `--Users-anton-Dev-cate--`. The encoding is POSIX-shaped (slashes → dashes),
 *  so it operates on the HOST path, never the locator. */
export function encodeHostCwdForSessions(hostCwd: string): string {
  const trimmed = hostCwd.replace(/\/+$/, '')
  const dashed = trimmed.replace(/\//g, '-')
  return `-${dashed}--`
}

/** Per-workspace pi sessions dir on the host that runs pi. */
export function hostSessionsDir(companionId: string, hostCwd: string): string {
  return hostJoin(companionId, hostAgentDir(companionId, hostCwd), 'sessions', encodeHostCwdForSessions(hostCwd))
}

/** The single shared auth.json — source of truth for provider credentials. */
export function sharedAuthPath(): string {
  return path.join(app.getPath('userData'), PI_AGENT_DIR, 'auth.json')
}

/** Legacy global pi auth, used once to seed the shared file. */
function legacyGlobalAuthPath(): string {
  return path.join(os.homedir(), '.pi', 'agent', 'auth.json')
}

async function readFileOrNull(p: string): Promise<string | null> {
  try { return await fsp.readFile(p, 'utf-8') }
  catch { return null }
}

async function ensureSharedAuth(): Promise<void> {
  const shared = sharedAuthPath()
  if (fs.existsSync(shared)) return
  const legacy = await readFileOrNull(legacyGlobalAuthPath())
  await writeTextAtomic(shared, legacy ?? '{}\n', { mode: 0o600 })
}

/** Push the shared auth.json into the host's workspace copy via the companion. */
async function pushAuthToHost(companion: Companion, hostCwd: string): Promise<void> {
  const data = await readFileOrNull(sharedAuthPath())
  if (data == null) return
  const dir = hostAgentDir(companion.id, hostCwd)
  await companion.file.mkdir(dir)
  await companion.file.writeFile(hostJoin(companion.id, dir, 'auth.json'), data)
}

/** Create the host's pi-agent dir, seed auth.json, and keep .cate out of VCS. */
export async function prepareAgentDir(companion: Companion, hostCwd: string): Promise<void> {
  await ensureSharedAuth()
  await companion.file.mkdir(hostAgentDir(companion.id, hostCwd))
  await pushAuthToHost(companion, hostCwd)
  // .cate/.gitignore ignores everything but workspace.json (best-effort).
  const gi = hostJoin(companion.id, hostCwd, CATE_DIR, '.gitignore')
  try {
    await companion.file.stat(gi)
  } catch {
    try { await companion.file.writeFile(gi, '*\n!workspace.json\n') } catch { /* best effort */ }
  }
}

/** Push the shared auth into the host copy (cate UI changed credentials). */
export async function pushSharedToWorkspace(companion: Companion, hostCwd: string): Promise<void> {
  await pushAuthToHost(companion, hostCwd)
}

async function syncBack(companion: Companion, hostCwd: string): Promise<void> {
  // Shared queue with authManager so two workspaces refreshing tokens (or a
  // UI-driven credential write) can't interleave on the shared auth.json.
  await sharedAuthWriteQueue(async () => {
    const authPath = hostJoin(companion.id, hostAgentDir(companion.id, hostCwd), 'auth.json')
    let wsData: string | null
    try { wsData = await companion.file.readFile(authPath) } catch { return }
    if (wsData == null) return
    const sharedData = await readFileOrNull(sharedAuthPath())
    if (wsData === sharedData) return // echo of our own push, or no real change
    await writeTextAtomic(sharedAuthPath(), wsData, { mode: 0o600 })
    log.info('[agentDir] synced workspace auth back to shared')
  })
}

/** Watch the host's auth.json; when pi rewrites it (OAuth refresh) copy back to
 *  the shared file. Returns a disposer. */
export function watchWorkspaceAuth(companion: Companion, hostCwd: string): () => void {
  const authPath = hostJoin(companion.id, hostAgentDir(companion.id, hostCwd), 'auth.json')
  let unsub: (() => void) | null = null
  try {
    unsub = companion.file.watch(authPath, () => { void syncBack(companion, hostCwd) })
  } catch (err) {
    log.warn('[agentDir] failed to watch %s: %O', authPath, err)
  }
  return () => { try { unsub?.() } catch { /* */ } }
}
