// =============================================================================
// agentDir — per-workspace home for the pi coding agent, seeded THROUGH the
// runtime so it works whether the workspace is local or on a remote host.
//
// Pi resolves its config dir (extensions, sessions, settings.json, auth.json)
// from PI_CODING_AGENT_DIR; we point it per-workspace at <cwd>/.cate/pi-agent on
// whichever host pi runs. Provider logins aren't project-specific, so a single
// shared auth.json lives in cate's userData (always local) and is mirrored into
// each workspace's dir via runtime.file (local fs for the local runtime, or
// the daemon for a remote one) with a copy-on-spawn + watch-and-copy-back scheme.
// =============================================================================

import fs from 'fs'
import fsp from 'fs/promises'
import os from 'os'
import path from 'path'
import { app } from 'electron'
import log from '../../main/logger'
import { writeTextAtomic } from '../../main/writeJsonAtomic'
import { LOCAL_RUNTIME_ID } from '../../main/runtime/locator'
import { sharedAuthWriteQueue } from './writeQueue'
import type { Runtime } from '../../main/runtime/types'

const CATE_DIR = '.cate'
export const PI_AGENT_DIR = 'pi-agent'
/** The Cate Agent's headless sessions live in their OWN per-workspace pi dir so
 *  their transcripts never land in `pi-agent/sessions` — the dir the agent panel
 *  lists and resumes. Same auth/models, fully separate session store + extensions. */
export const PI_AGENT_CATE_AGENT_DIR = 'pi-agent-cate-agent'

/** Which per-workspace pi dir a session uses: the normal one (agent panel) or the
 *  isolated Cate Agent one. Drives the agent dir, sessions store, and extensions. */
export type AgentDirVariant = 'default' | 'cateAgent'

function agentDirName(variant: AgentDirVariant): string {
  return variant === 'cateAgent' ? PI_AGENT_CATE_AGENT_DIR : PI_AGENT_DIR
}

/** Per-workspace pi config dir on the LOCAL machine (native path). Used by the
 *  local skill-file IPC; runtime-aware code uses hostAgentDir(). */
export function agentDirFor(cwd: string, variant: AgentDirVariant = 'default'): string {
  return path.join(cwd, CATE_DIR, agentDirName(variant))
}

/** Per-workspace pi config dir on the host that runs pi. Remote hosts are POSIX,
 *  the local machine uses native separators. */
export function hostAgentDir(runtimeId: string, hostCwd: string, variant: AgentDirVariant = 'default'): string {
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
export function hostSessionsDir(runtimeId: string, hostCwd: string, variant: AgentDirVariant = 'default'): string {
  return hostJoin(runtimeId, hostAgentDir(runtimeId, hostCwd, variant), 'sessions', encodeHostCwdForSessions(hostCwd))
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

/** Push the shared auth.json into the host's workspace copy via the runtime. */
async function pushAuthToHost(runtime: Runtime, hostCwd: string, variant: AgentDirVariant): Promise<void> {
  const data = await readFileOrNull(sharedAuthPath())
  if (data == null) return
  const dir = hostAgentDir(runtime.id, hostCwd, variant)
  await runtime.file.mkdir(dir)
  await runtime.file.writeFile(hostJoin(runtime.id, dir, 'auth.json'), data)
}

/** Create the host's pi-agent dir, seed auth.json, and keep .cate out of VCS. */
export async function prepareAgentDir(runtime: Runtime, hostCwd: string, variant: AgentDirVariant = 'default'): Promise<void> {
  await ensureSharedAuth()
  await runtime.file.mkdir(hostAgentDir(runtime.id, hostCwd, variant))
  await pushAuthToHost(runtime, hostCwd, variant)
  // .cate/.gitignore ignores everything but workspace.json (best-effort).
  const gi = hostJoin(runtime.id, hostCwd, CATE_DIR, '.gitignore')
  try {
    await runtime.file.stat(gi)
  } catch {
    try { await runtime.file.writeFile(gi, '*\n!workspace.json\n') } catch { /* best effort */ }
  }
}

/** Push the shared auth into the host copy (cate UI changed credentials). */
export async function pushSharedToWorkspace(runtime: Runtime, hostCwd: string, variant: AgentDirVariant = 'default'): Promise<void> {
  await pushAuthToHost(runtime, hostCwd, variant)
}

async function syncBack(runtime: Runtime, hostCwd: string, variant: AgentDirVariant): Promise<void> {
  // Shared queue with authManager so two workspaces refreshing tokens (or a
  // UI-driven credential write) can't interleave on the shared auth.json.
  await sharedAuthWriteQueue(async () => {
    const authPath = hostJoin(runtime.id, hostAgentDir(runtime.id, hostCwd, variant), 'auth.json')
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
export function watchWorkspaceAuth(runtime: Runtime, hostCwd: string, variant: AgentDirVariant = 'default'): () => void {
  const authPath = hostJoin(runtime.id, hostAgentDir(runtime.id, hostCwd, variant), 'auth.json')
  let unsub: (() => void) | null = null
  try {
    unsub = runtime.file.watch(authPath, () => { void syncBack(runtime, hostCwd, variant) })
  } catch (err) {
    log.warn('[agentDir] failed to watch %s: %O', authPath, err)
  }
  return () => { try { unsub?.() } catch { /* */ } }
}
