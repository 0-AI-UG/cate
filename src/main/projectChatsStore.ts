// =============================================================================
// projectChatsStore — per-workspace chat threads at `<project>/.cate/chats.json`.
//
// The Cate Agent's front door: each chat is a persistent thread of typed messages
// (text / plan / attempts / result / canvas) plus the live/last `run` state for a
// code task. The renderer holds the authoritative in-memory list and mirrors every
// mutation here. Local roots write directly (atomic tmp+rename); remote roots
// write the same file through the runtime, so chats survive a restart wherever
// the workspace lives. `.cate/.gitignore` keeps it out of the user's VCS.
//
// A hand-edited / partial file must degrade gracefully rather than crash, so
// every record is coerced on load.
// =============================================================================

import { ipcMain } from 'electron'
import fs from 'fs/promises'
import path from 'path'
import log from './logger'
import { PROJECT_CHATS_LOAD, PROJECT_CHATS_SAVE } from '../shared/ipc-channels'
import type {
  Chat,
  ChatMessage,
  ChatRun,
  ProjectChatsFile,
  Iteration,
  IterationAgent,
  IterationStatus,
  VerifyResult,
} from '../shared/types'
import { writeJsonAtomic } from './writeJsonAtomic'
import { quarantineCorruptFile } from './quarantineCorruptFile'
import { ensureCateGitignore, CATE_GITIGNORE_CONTENT } from './cateGitignore'
import { isLocalLocator, parseLocator } from './runtime/locator'
import { runtimes } from './runtime/runtimeManager'

const CATE_DIR = '.cate'
const CHATS_FILE = 'chats.json'

function cateDir(rootPath: string): string {
  return path.join(rootPath, CATE_DIR)
}

function chatsPath(rootPath: string): string {
  return path.join(rootPath, CATE_DIR, CHATS_FILE)
}

const VALID_ITERATION_STATUS = new Set<IterationStatus>([
  'running', 'finished', 'verifying', 'passed', 'failed', 'error', 'cancelled',
])
const VALID_RUN_STATUS = new Set<ChatRun['status']>(['running', 'review', 'done', 'failed'])

/** Coerce one raw agent record, dropping anything without a terminalId — the chip
 *  keys off it, so a record without one is useless. */
function normalizeAgent(raw: unknown): IterationAgent | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (typeof o.terminalId !== 'string') return null
  if (o.kind !== 'work' && o.kind !== 'verify') return null
  const agent: IterationAgent = {
    agent: typeof o.agent === 'string' ? o.agent : 'coding agent',
    terminalId: o.terminalId,
    kind: o.kind,
  }
  if (typeof o.scope === 'string') agent.scope = o.scope
  return agent
}

/** Coerce one raw iteration. The terminal chips, verdict lines, and round framing
 *  all read these, so they must survive the disk round-trip. */
function normalizeIteration(raw: unknown): Iteration | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (typeof o.id !== 'string' || typeof o.todoId !== 'string') return null
  const status = typeof o.status === 'string' && VALID_ITERATION_STATUS.has(o.status as IterationStatus)
    ? (o.status as IterationStatus)
    : 'running'
  const it: Iteration = {
    id: o.id,
    todoId: o.todoId,
    round: typeof o.round === 'number' ? o.round : 0,
    agents: Array.isArray(o.agents) ? o.agents.map(normalizeAgent).filter((a): a is IterationAgent => a !== null) : [],
    status,
    createdAt: typeof o.createdAt === 'number' ? o.createdAt : 0,
  }
  if (typeof o.worktreeId === 'string') it.worktreeId = o.worktreeId
  if (typeof o.branch === 'string') it.branch = o.branch
  const v = o.verify
  if (v && typeof v === 'object') {
    const vo = v as Record<string, unknown>
    if (typeof vo.reason === 'string' && typeof vo.at === 'number') {
      it.verify = { met: vo.met === true, reason: vo.reason, at: vo.at } satisfies VerifyResult
    }
  }
  return it
}

/** Coerce one raw run block, or undefined when absent/unusable. */
function normalizeRun(raw: unknown): ChatRun | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const o = raw as Record<string, unknown>
  const status = typeof o.status === 'string' && VALID_RUN_STATUS.has(o.status as ChatRun['status'])
    ? (o.status as ChatRun['status'])
    : 'running'
  const run: ChatRun = { status }
  if (typeof o.goal === 'string') run.goal = o.goal
  if (typeof o.check === 'string') run.check = o.check
  if (typeof o.round === 'number') run.round = o.round
  if (typeof o.recommendedIterationId === 'string') run.recommendedIterationId = o.recommendedIterationId
  if (typeof o.worktreeId === 'string') run.worktreeId = o.worktreeId
  if (typeof o.branch === 'string') run.branch = o.branch
  if (Array.isArray(o.terminalNodeIds)) run.terminalNodeIds = o.terminalNodeIds.filter((x): x is string => typeof x === 'string')
  if (typeof o.canvasPanelId === 'string') run.canvasPanelId = o.canvasPanelId
  if (typeof o.note === 'string') run.note = o.note
  if (o.interrupted === true) run.interrupted = true
  if (typeof o.attemptsMessageId === 'string') run.attemptsMessageId = o.attemptsMessageId
  if (Array.isArray(o.iterations)) {
    run.iterations = o.iterations.map(normalizeIteration).filter((i): i is Iteration => i !== null)
  }
  return run
}

/** Coerce one raw message. Unknown kinds / missing ids drop the whole record. */
function normalizeMessage(raw: unknown): ChatMessage | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (typeof o.id !== 'string') return null
  const role = o.role === 'user' ? 'user' : 'agent'
  const ts = typeof o.ts === 'number' ? o.ts : 0
  switch (o.kind) {
    case 'text':
      if (typeof o.text !== 'string') return null
      return { id: o.id, role, ts, kind: 'text', text: o.text }
    case 'plan':
      return { id: o.id, role: 'agent', ts, kind: 'plan', goal: typeof o.goal === 'string' ? o.goal : '', check: typeof o.check === 'string' ? o.check : '' }
    case 'attempts': {
      const m: ChatMessage = { id: o.id, role: 'agent', ts, kind: 'attempts' }
      if (Array.isArray(o.iterations)) m.iterations = o.iterations.map(normalizeIteration).filter((i): i is Iteration => i !== null)
      if (typeof o.round === 'number') m.round = o.round
      if (typeof o.recommendedIterationId === 'string') m.recommendedIterationId = o.recommendedIterationId
      return m
    }
    case 'result': {
      const m: ChatMessage = { id: o.id, role: 'agent', ts, kind: 'result', met: o.met === true, reason: typeof o.reason === 'string' ? o.reason : '' }
      if (typeof o.iterationId === 'string') m.iterationId = o.iterationId
      if (typeof o.worktreeId === 'string') m.worktreeId = o.worktreeId
      if (typeof o.branch === 'string') m.branch = o.branch
      if (o.outcome === 'merged' || o.outcome === 'pr' || o.outcome === 'discarded') m.outcome = o.outcome
      if (typeof o.note === 'string') m.note = o.note
      return m
    }
    case 'canvas': {
      const m: ChatMessage = { id: o.id, role: 'agent', ts, kind: 'canvas', request: typeof o.request === 'string' ? o.request : '', working: o.working === true }
      if (Array.isArray(o.panels)) {
        m.panels = o.panels
          .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object')
          .map((p) => ({ id: String(p.id ?? ''), type: String(p.type ?? ''), title: String(p.title ?? '') }))
      }
      if (typeof o.canvasPanelId === 'string') m.canvasPanelId = o.canvasPanelId
      return m
    }
    default:
      return null
  }
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
    messages: Array.isArray(o.messages) ? o.messages.map(normalizeMessage).filter((m): m is ChatMessage => m !== null) : [],
  }
  const run = normalizeRun(o.run)
  if (run) chat.run = run
  if (typeof o.sessionFile === 'string') chat.sessionFile = o.sessionFile
  const task = o.engineeringTask
  if (task && typeof task === 'object') {
    const candidate = task as Record<string, unknown>
    if (typeof candidate.goal === 'string' && typeof candidate.acceptedAt === 'number') {
      chat.engineeringTask = {
        goal: candidate.goal,
        acceptedAt: candidate.acceptedAt,
        ...(typeof candidate.check === 'string' ? { check: candidate.check } : {}),
        ...(typeof candidate.overview === 'string' ? { overview: candidate.overview } : {}),
      }
    }
  }
  // Direct-agent model/session metadata and an approved engineering handoff are
  // durable parts of the one unified chat record.
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
