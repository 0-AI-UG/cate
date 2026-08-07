// =============================================================================
// projectChatsStore — per-workspace chat threads at `<project>/.cate/chats.json`.
//
// The Cate Agent's front door: each record points at one Pi main-agent session.
// Pi owns the transcript; Cate stores only chat metadata and placement.
//
// A hand-edited / partial file must degrade gracefully rather than crash, so
// every record is coerced on load.
// =============================================================================

import { ipcMain } from 'electron'
import fs from 'fs/promises'
import path from 'path'
import log from './logger'
import { PROJECT_CHATS_LOAD, PROJECT_CHATS_SAVE } from '../shared/ipc-channels'
import type { Chat, ProjectChatsFile } from '../shared/types'
import { writeJsonAtomic } from './writeJsonAtomic'
import { quarantineCorruptFile } from './quarantineCorruptFile'
import { ensureCateGitignore, CATE_GITIGNORE_CONTENT } from './cateGitignore'
import { isLocalLocator, parseLocator } from '../shared/runtimeLocator'
import { runtimes } from './runtime/runtimeManager'

const CATE_DIR = '.cate'
const CHATS_FILE = 'chats.json'

function cateDir(rootPath: string): string {
  return path.join(rootPath, CATE_DIR)
}

function chatsPath(rootPath: string): string {
  return path.join(rootPath, CATE_DIR, CHATS_FILE)
}

/** Coerce one raw parsed entry into a complete Chat, or null if unusable. */
function normalizeChat(raw: unknown): Chat | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (typeof o.id !== 'string' || typeof o.title !== 'string') return null
  const chat: Chat = {
    id: o.id,
    title: o.title,
    createdAt: typeof o.createdAt === 'number' ? o.createdAt : 0,
    updatedAt: typeof o.updatedAt === 'number' ? o.updatedAt : 0,
  }
  if (typeof o.hostPanelId === 'string') chat.hostPanelId = o.hostPanelId
  if (typeof o.worktreeId === 'string') chat.worktreeId = o.worktreeId
  if (typeof o.sessionFile === 'string') chat.sessionFile = o.sessionFile
  const m = o.model
  if (m && typeof m === 'object' && typeof (m as Record<string, unknown>).provider === 'string' && typeof (m as Record<string, unknown>).model === 'string') {
    chat.model = { provider: (m as { provider: string }).provider, model: (m as { model: string }).model }
  }
  return chat
}

/** Coerce a parsed chats file into a clean Chat[] (shared local/remote). */
function normalizeChatsFile(parsed: unknown): Chat[] {
  const o = parsed as Partial<ProjectChatsFile> | null
  if (!o || !Array.isArray(o.chats)) return []
  return o.chats.map(normalizeChat).filter((c): c is Chat => c !== null)
}

// Remote workspaces persist the same `.cate/chats.json` through the runtime
// (remote paths are POSIX; runtime.file.writeFile is atomic tmp+rename on the
// host, matching writeJsonAtomic locally). A corrupt file isn't quarantined
// over RPC — it degrades to an empty list, same posture as
// projectWorkspaceStore's remote branch.
function remoteTargets(rootPath: string) {
  const { runtimeId, path: base } = parseLocator(rootPath)
  const dir = path.posix.join(base, CATE_DIR)
  return {
    runtime: runtimes.resolve(runtimeId),
    file: path.posix.join(dir, CHATS_FILE),
    gitignoreFile: path.posix.join(dir, '.gitignore'),
  }
}

async function loadChatsRemote(rootPath: string): Promise<Chat[]> {
  const { runtime, file } = remoteTargets(rootPath)
  const raw = await runtime.file.readFile(file).catch(() => null)
  if (!raw) return [] // absent (or runtime hiccup) — no chats yet
  try {
    return normalizeChatsFile(JSON.parse(raw))
  } catch {
    log.warn('[projectChatsStore] corrupt remote %s; starting empty', file)
    return []
  }
}

async function saveChatsRemote(rootPath: string, chats: Chat[]): Promise<void> {
  const { runtime, file, gitignoreFile } = remoteTargets(rootPath)
  // Write-once .gitignore, mirroring ensureCateGitignore on the local branch.
  await runtime.file
    .stat(gitignoreFile)
    .catch(() => runtime.file.writeFile(gitignoreFile, CATE_GITIGNORE_CONTENT))
  const payload: ProjectChatsFile = { version: 1, chats }
  await runtime.file.writeFile(file, `${JSON.stringify(payload, null, 2)}\n`)
}

/** Read `.cate/chats.json` for a project. Missing → []; unparseable →
 *  quarantined locally (kept for recovery) then []. */
export async function loadChats(rootPath: string): Promise<Chat[]> {
  if (!isLocalLocator(rootPath)) return loadChatsRemote(rootPath)
  let raw: string
  try {
    raw = await fs.readFile(chatsPath(rootPath), 'utf-8')
  } catch {
    return [] // absent — no chats yet
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // Unparseable (bad hand-edit / crash mid-write): quarantine the broken file
    // so it survives for recovery instead of being silently overwritten by the
    // next save — the same posture jsonStateFile applies to userData files.
    const backup = quarantineCorruptFile(chatsPath(rootPath))
    log.warn('[projectChatsStore] corrupt %s%s; starting empty', chatsPath(rootPath), backup ? `, backed up to ${backup}` : '')
    return []
  }
  return normalizeChatsFile(parsed)
}

/** Persist the whole chat list for a project (atomic tmp+rename on both paths). */
export async function saveChats(rootPath: string, chats: Chat[]): Promise<void> {
  if (!isLocalLocator(rootPath)) return saveChatsRemote(rootPath, chats)
  const file: ProjectChatsFile = { version: 1, chats }
  await ensureCateGitignore(cateDir(rootPath))
  await writeJsonAtomic(chatsPath(rootPath), file)
}

export function registerProjectChatsHandlers(): void {
  ipcMain.handle(PROJECT_CHATS_LOAD, async (_event, rootPath: string) => loadChats(rootPath))

  ipcMain.handle(PROJECT_CHATS_SAVE, async (_event, rootPath: string, chats: Chat[]) => {
    try {
      await saveChats(rootPath, chats)
    } catch (err) {
      log.warn('[projectChatsStore] save failed for %s: %O', cateDir(rootPath), err)
    }
  })
}
