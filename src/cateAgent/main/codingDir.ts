// =============================================================================
// agentDir — per-workspace home for the pi coding agent, seeded THROUGH the
// runtime so it works whether the workspace is local or on a remote host.
//
// Pi resolves its config dir (extensions, sessions, settings.json, auth.json)
// from PI_CODING_AGENT_DIR; we point it per-workspace at <cwd>/.cate/cate-agent on
// whichever host pi runs. Provider logins aren't project-specific, so a single
// shared auth.json lives in cate's userData (always local) and is mirrored into
// each workspace's dir via runtime.file (local fs for the local runtime, or
// the daemon for a remote one) with a copy-on-spawn + watch-and-copy-back scheme.
// =============================================================================

import fs from 'fs'
import fsp from 'fs/promises'
import path from 'path'
import { app } from 'electron'
import log from '../../main/logger'
import { writeTextAtomic } from '../../main/writeJsonAtomic'
import { LOCAL_RUNTIME_ID } from '../../main/runtime/locator'
import { codingConfigLock } from './codingConfigLock'
import type { Runtime } from '../../main/runtime/types'
import { CATE_GITIGNORE_CONTENT } from '../../main/cateGitignore'

const CATE_DIR = '.cate'
export const CODING_AGENT_DIR = 'cate-agent'
/** The Cate Agent (loop)'s headless sessions live in their OWN per-workspace pi dir
 *  so their transcripts never land in `cate-agent/sessions` — the dir the agent panel
 *  lists and resumes. Same auth/models, fully separate session store + extensions. */
export const CATE_AGENT_LOOP_DIR = 'cate-agent-loop'

/** Which per-workspace pi dir a session uses: the normal one (agent panel) or the
 *  isolated Cate Agent one. Drives the agent dir, sessions store, and extensions. */
export type CodingDirVariant = 'default' | 'cateAgent'

function agentDirName(variant: CodingDirVariant): string {
  return variant === 'cateAgent' ? CATE_AGENT_LOOP_DIR : CODING_AGENT_DIR
}

/** Per-workspace pi config dir on the LOCAL machine (native path). Used by the
 *  local skill-file IPC; runtime-aware code uses hostCodingDir(). */
export function codingDirFor(cwd: string, variant: CodingDirVariant = 'default'): string {
  return path.join(cwd, CATE_DIR, agentDirName(variant))
}

/** Per-workspace pi config dir on the host that runs pi. Remote hosts are POSIX,
 *  the local machine uses native separators. */
export function hostCodingDir(runtimeId: string, hostCwd: string, variant: CodingDirVariant = 'default'): string {
  const join = runtimeId === LOCAL_RUNTIME_ID ? path.join : path.posix.join
  return join(hostCwd, CATE_DIR, agentDirName(variant))
}

export function hostJoin(runtimeId: string, ...segs: string[]): string {
  return (runtimeId === LOCAL_RUNTIME_ID ? path.join : path.posix.join)(...segs)
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
export function hostSessionsDir(runtimeId: string, hostCwd: string, variant: CodingDirVariant = 'default'): string {
  return hostJoin(runtimeId, hostCodingDir(runtimeId, hostCwd, variant), 'sessions', encodeHostCwdForSessions(hostCwd))
}

/** The single shared auth.json — source of truth for provider credentials. */
export function sharedAuthPath(): string {
  return path.join(app.getPath('userData'), CODING_AGENT_DIR, 'auth.json')
}

async function readFileOrNull(p: string): Promise<string | null> {
  try { return await fsp.readFile(p, 'utf-8') }
  catch { return null }
}

async function ensureSharedAuth(): Promise<void> {
  await codingConfigLock.run('auth.json', async () => {
    const shared = sharedAuthPath()
    if (fs.existsSync(shared)) return
    await writeTextAtomic(shared, '{}\n', { mode: 0o600 })
  })
}

/** Push the shared auth.json into the host's workspace copy via the runtime. */
async function pushAuthToHost(runtime: Runtime, hostCwd: string, variant: CodingDirVariant): Promise<void> {
  const data = await readFileOrNull(sharedAuthPath())
  if (data == null) return
  const dir = hostCodingDir(runtime.id, hostCwd, variant)
  await runtime.file.mkdir(dir)
  await runtime.file.writeFile(hostJoin(runtime.id, dir, 'auth.json'), data)
}

/** Create the host's cate-agent dir, seed auth.json, and keep .cate out of VCS. */
export async function prepareCodingDir(runtime: Runtime, hostCwd: string, variant: CodingDirVariant = 'default'): Promise<void> {
  await ensureSharedAuth()
  await runtime.file.mkdir(hostCodingDir(runtime.id, hostCwd, variant))
  await pushAuthToHost(runtime, hostCwd, variant)
  // .cate/.gitignore ignores everything but workspace.json (best-effort).
  const gi = hostJoin(runtime.id, hostCwd, CATE_DIR, '.gitignore')
  try {
    await runtime.file.stat(gi)
  } catch {
    try { await runtime.file.writeFile(gi, CATE_GITIGNORE_CONTENT) } catch { /* best effort */ }
  }
}

/** Push the shared auth into the host copy (cate UI changed credentials). */
export async function pushSharedToWorkspace(runtime: Runtime, hostCwd: string, variant: CodingDirVariant = 'default'): Promise<void> {
  await pushAuthToHost(runtime, hostCwd, variant)
}

async function syncBack(runtime: Runtime, hostCwd: string, variant: CodingDirVariant): Promise<void> {
  // Shared queue with authManager so two workspaces refreshing tokens (or a
  // UI-driven credential write) can't interleave on the shared auth.json.
  await codingConfigLock.run('auth.json', async () => {
    const authPath = hostJoin(runtime.id, hostCodingDir(runtime.id, hostCwd, variant), 'auth.json')
    let wsData: string | null
    try { wsData = await runtime.file.readFile(authPath) } catch { return }
    if (wsData == null) return
    const sharedData = await readFileOrNull(sharedAuthPath())
    if (wsData === sharedData) return // echo of our own push, or no real change
    await writeTextAtomic(sharedAuthPath(), wsData, { mode: 0o600 })
    log.info('[agentDir] synced workspace auth back to shared')
  })
}

/** Watch the host's auth.json; when pi rewrites it (OAuth refresh) copy back to
 *  the shared file. Returns a disposer. */
export function watchWorkspaceAuth(runtime: Runtime, hostCwd: string, variant: CodingDirVariant = 'default'): () => void {
  const authPath = hostJoin(runtime.id, hostCodingDir(runtime.id, hostCwd, variant), 'auth.json')
  let unsub: (() => void) | null = null
  try {
    unsub = runtime.file.watch(authPath, () => { void syncBack(runtime, hostCwd, variant) })
  } catch (err) {
    log.warn('[agentDir] failed to watch %s: %O', authPath, err)
  }
  return () => { try { unsub?.() } catch { /* */ } }
}
