import { ipcMain } from 'electron'
import fs from 'fs/promises'
import fsSync from 'fs'
import crypto from 'crypto'
import path from 'path'
import log from './logger'
import {
  PROJECT_STATE_SAVE,
  PROJECT_STATE_LOAD,
  WORKSPACE_EXTERNAL_EDIT,
  WORKSPACE_EXTERNAL_EDIT_DISMISS,
} from '../shared/ipc-channels'
import { holdsProjectLock, acquireProjectLock } from './projectLock'
import type { ProjectWorkspaceFile, ProjectSessionFile } from '../shared/types'
import { toRelativePath } from '../shared/pathUtils'
import { broadcastToAll } from './windowRegistry'
import { ensureCateGitignore } from './cateGitignore'

const CATE_DIR = '.cate'
const WORKSPACE_FILE = 'workspace.json'
const SESSION_FILE = 'session.json'

function cateDir(rootPath: string): string {
  return path.join(rootPath, CATE_DIR)
}

function workspacePath(rootPath: string): string {
  return path.join(rootPath, CATE_DIR, WORKSPACE_FILE)
}

function sessionPath(rootPath: string): string {
  return path.join(rootPath, CATE_DIR, SESSION_FILE)
}

// ---------------------------------------------------------------------------
// External-edit guard for workspace.json
//
// workspace.json is committable and may be edited on disk (by hand or another
// tool) while Cate is running. But the renderer also autosaves the live layout
// back over it (~30s + on quit), which would clobber any such edit. To prevent
// that, we remember the hash of the content we last wrote/read per project;
// before any autosave overwrite we compare it against what's on disk. A mismatch means the file was edited
// behind our back, so we skip the overwrite and preserve the edit until the
// user reloads the workspace from disk.
// ---------------------------------------------------------------------------

const lastWrittenWorkspaceHash = new Map<string, string>()

function hashContent(content: string): string {
  return crypto.createHash('sha1').update(content).digest('hex')
}

/** Record the hash of the exact content now living on disk for this project. */
function rememberWorkspaceContent(rootPath: string, content: string): void {
  lastWrittenWorkspaceHash.set(rootPath, hashContent(content))
}

/**
 * True iff the on-disk workspace.json differs from what we last wrote/read —
 * i.e. it was edited externally and an autosave would clobber that edit. When
 * we've never tracked this project, or the file is gone, returns false (nothing
 * to protect, let the write proceed).
 */
function workspaceEditedExternallyAsync(rootPath: string): Promise<boolean> {
  const known = lastWrittenWorkspaceHash.get(rootPath)
  if (known === undefined) return Promise.resolve(false)
  return fs
    .readFile(workspacePath(rootPath), 'utf-8')
    .then((current) => hashContent(current) !== known)
    .catch(() => false)
}

function workspaceEditedExternallySync(rootPath: string): boolean {
  const known = lastWrittenWorkspaceHash.get(rootPath)
  if (known === undefined) return false
  try {
    return hashContent(fsSync.readFileSync(workspacePath(rootPath), 'utf-8')) !== known
  } catch {
    return false
  }
}

// Per-write unique temp suffix. A shared `<file>.tmp` name is unsafe when two
// saves for the same path overlap: one consumes the tmp, the other's rename
// fails with ENOENT. Uniquify so each write owns its own tmp file.
let tmpSeq = 0
function uniqueTmpPath(filePath: string): string {
  tmpSeq = (tmpSeq + 1) & 0x7fffffff
  return `${filePath}.${process.pid}.${tmpSeq}.tmp`
}

async function atomicWrite(filePath: string, json: string): Promise<void> {
  const dir = path.dirname(filePath)
  const tmpPath = uniqueTmpPath(filePath)
  const bakPath = filePath + '.bak'

  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(tmpPath, json, 'utf-8')
  const stat = await fs.stat(tmpPath)
  if (stat.size === 0) {
    await fs.unlink(tmpPath).catch(() => {})
    throw new Error('tmp file is empty after write')
  }
  // Back up by *copying* (not renaming) the current file so it never vanishes
  // if this rename races a concurrent writer. The rename below is atomic and
  // overwrites the target in place.
  await fs.copyFile(filePath, bakPath).catch(() => {})
  await fs.rename(tmpPath, filePath)
}

function atomicWriteSync(filePath: string, json: string): void {
  const dir = path.dirname(filePath)
  const tmpPath = uniqueTmpPath(filePath)
  const bakPath = filePath + '.bak'

  fsSync.mkdirSync(dir, { recursive: true })
  fsSync.writeFileSync(tmpPath, json, 'utf-8')
  const stat = fsSync.statSync(tmpPath)
  if (stat.size === 0) {
    throw new Error('tmp file is empty after write')
  }
  try { fsSync.copyFileSync(filePath, bakPath) } catch { /* OK */ }
  fsSync.renameSync(tmpPath, filePath)
}

async function tryReadJson<T>(filePath: string): Promise<T | null> {
  try {
    const data = await fs.readFile(filePath, 'utf-8')
    return JSON.parse(data) as T
  } catch {
    return null
  }
}

// Count of canvas nodes in a workspace file, or -1 when the value isn't a
// readable workspace. Used by the data-loss guards (issue #220) to compare the
// richness of two candidate files / an incoming write vs. what's on disk.
function workspaceNodeCount(data: unknown): number {
  if (!isValidWorkspace(data)) return -1
  // Total canvas nodes across every canvas (primary + secondary). The richness
  // comparison only cares about the aggregate count, not which canvas owns them.
  const canvases = (data as ProjectWorkspaceFile).canvases
  if (!canvases) return 0
  let count = 0
  for (const canvas of Object.values(canvases)) {
    count += Object.keys(canvas.canvasNodes ?? {}).length
  }
  return count
}

// True when writing `incomingNodeCount` nodes over the workspace.json at
// `rootPath` would replace a non-empty saved canvas with an empty one — the
// issue #220 data-loss footgun. The sync read keeps the quit-time fallback
// (saveProjectStateSync) honest without an await.
function wouldEmptyOverwriteWorkspaceSync(rootPath: string, incomingNodeCount: number): boolean {
  if (incomingNodeCount > 0) return false
  try {
    const existing = JSON.parse(fsSync.readFileSync(workspacePath(rootPath), 'utf-8'))
    return workspaceNodeCount(existing) > 0
  } catch {
    return false
  }
}

async function tryReadWithFallback<T>(filePath: string): Promise<T | null> {
  const result = await tryReadJson<T>(filePath)
  if (result) return result
  const tmp = await tryReadJson<T>(filePath + '.tmp')
  if (tmp) return tmp
  return tryReadJson<T>(filePath + '.bak')
}

// Workspace-aware read (issue #220): the plain primary file can be a valid but
// *empty* canvas left behind by a wipe. When that happens, prefer the richer of
// primary / .tmp / .bak so a previously-wiped workspace still recovers its
// panels on the next load instead of perpetuating the empty state.
async function readWorkspaceWithFallback(filePath: string): Promise<ProjectWorkspaceFile | null> {
  const candidates = await Promise.all([
    tryReadJson<ProjectWorkspaceFile>(filePath),
    tryReadJson<ProjectWorkspaceFile>(filePath + '.tmp'),
    tryReadJson<ProjectWorkspaceFile>(filePath + '.bak'),
  ])
  let best: ProjectWorkspaceFile | null = null
  let bestCount = -1
  for (const candidate of candidates) {
    const count = workspaceNodeCount(candidate)
    if (count > bestCount) {
      best = candidate
      bestCount = count
    }
  }
  return best
}

function isValidWorkspace(data: unknown): data is ProjectWorkspaceFile {
  if (!data || typeof data !== 'object') return false
  const obj = data as Record<string, unknown>
  // workspace.json carries the shareable name/color; session.json does not —
  // that's what tells the two version-1 files apart.
  return obj.version === 1 && typeof obj.name === 'string' && typeof obj.color === 'string'
}

function isValidSession(data: unknown): data is ProjectSessionFile {
  if (!data || typeof data !== 'object') return false
  const obj = data as Record<string, unknown>
  return obj.version === 1 && obj.panels != null
}

export async function saveProjectState(
  rootPath: string,
  workspace: ProjectWorkspaceFile,
  session: ProjectSessionFile,
): Promise<void> {
  // Data-loss backstop (issue #220): never overwrite a non-empty saved canvas
  // with an empty one. A renderer-side race while activating a deferred
  // (non-selected) workspace can momentarily serialize an empty canvas; without
  // this guard that empty snapshot clobbers the good workspace.json/session.json
  // and the loss is permanent — the empty file is still structurally "valid", so
  // the .bak fallback is never consulted on the next load. The renderer reads
  // canvas state straight from the live store (the source of truth), so this
  // disk-boundary guard is the backstop that also covers deferred/non-selected
  // workspaces serializing a momentarily-empty canvas.
  if (workspaceNodeCount(workspace) <= 0) {
    const existingCount = workspaceNodeCount(await tryReadJson(workspacePath(rootPath)))
    if (existingCount > 0) {
      log.warn(
        'Refusing to overwrite %d-node canvas with an empty one for %s (issue #220 guard)',
        existingCount,
        cateDir(rootPath),
      )
      return
    }
  }
  const wsJson = JSON.stringify(workspace, null, 2)
  const sessJson = JSON.stringify(session, null, 2)
  await ensureCateGitignore(cateDir(rootPath))
  await Promise.all([
    atomicWrite(workspacePath(rootPath), wsJson),
    atomicWrite(sessionPath(rootPath), sessJson),
  ])
  log.debug('Project state saved to %s', cateDir(rootPath))
}

export async function loadProjectState(rootPath: string): Promise<{
  workspace: ProjectWorkspaceFile
  session: ProjectSessionFile | null
} | null> {
  const ws = await readWorkspaceWithFallback(workspacePath(rootPath))
  if (!ws || !isValidWorkspace(ws)) return null
  // Track the on-disk content so a later autosave can tell our own writes apart
  // from an external edit. Hash the raw file (not a re-serialization) so the
  // comparison is byte-exact.
  await fs
    .readFile(workspacePath(rootPath), 'utf-8')
    .then((raw) => rememberWorkspaceContent(rootPath, raw))
    .catch(() => {})
  const sess = await tryReadWithFallback<ProjectSessionFile>(sessionPath(rootPath))
  return {
    workspace: ws,
    session: sess && isValidSession(sess) ? sess : null,
  }
}

// Last-saved JSON for sync fallback on quit
const lastSavedProjectStates: Map<string, { workspace: string; session: string }> = new Map()

export function saveProjectStateSync(): void {
  for (const [rootPath, { workspace, session }] of lastSavedProjectStates) {
    try {
      atomicWriteSync(sessionPath(rootPath), session)
      if (workspaceEditedExternallySync(rootPath)) {
        log.info('Skipping workspace.json sync overwrite for %s — edited externally', cateDir(rootPath))
      } else if (wouldEmptyOverwriteWorkspaceSync(rootPath, workspaceNodeCount(JSON.parse(workspace)))) {
        // issue #220 guard: don't let the quit-time fallback flush an empty
        // canvas over a good one (mirrors the async saveProjectState guard).
        log.warn('Refusing empty workspace.json sync overwrite for %s (issue #220 guard)', cateDir(rootPath))
      } else {
        atomicWriteSync(workspacePath(rootPath), workspace)
        rememberWorkspaceContent(rootPath, workspace)
      }
    } catch (err) {
      log.warn('Sync project state save failed for %s: %O', rootPath, err)
    }
  }
}

// Serialize saves per root. Overlapping saves for the same project would race
// on disk and, worse, desync the remembered-hash guard (one write finishes
// last on disk while another finishes last in memory), spuriously flagging
// workspace.json as edited-externally. A per-root promise chain keeps them
// strictly ordered.
const saveQueues = new Map<string, Promise<unknown>>()

function enqueueSave(rootPath: string, task: () => Promise<void>): Promise<void> {
  const prev = saveQueues.get(rootPath) ?? Promise.resolve()
  const next = prev.catch(() => {}).then(task)
  saveQueues.set(rootPath, next)
  next.finally(() => {
    if (saveQueues.get(rootPath) === next) saveQueues.delete(rootPath)
  })
  return next
}

export function registerProjectStateHandlers(): void {
  ipcMain.handle(
    PROJECT_STATE_SAVE,
    async (_event, rootPath: string, workspace: ProjectWorkspaceFile, session: ProjectSessionFile) => {
      const wsJson = JSON.stringify(workspace, null, 2)
      const sessJson = JSON.stringify(session, null, 2)
      lastSavedProjectStates.set(rootPath, { workspace: wsJson, session: sessJson })
      // If another live Cate instance owns this project, don't autosave over
      // it — that's the two-writers loop. Re-acquire each time so we resume
      // saving once the owner exits; only skip while it's genuinely held.
      if (!holdsProjectLock(rootPath) && !acquireProjectLock(rootPath)) {
        log.debug('Skipping save for %s — another Cate instance owns it', cateDir(rootPath))
        lastSavedProjectStates.delete(rootPath) // keep the quit-time sync fallback out too
        return
      }
      await enqueueSave(rootPath, async () => {
        await ensureCateGitignore(cateDir(rootPath))
        // session.json is machine-local and never hand-edited, so always write it.
        const writes: Promise<void>[] = [atomicWrite(sessionPath(rootPath), sessJson)]
        if (await workspaceEditedExternallyAsync(rootPath)) {
          // Hold the overwrite and ask the renderer to prompt for a reload. The
          // file stays steady until the user reloads or dismisses the prompt.
          log.info('Skipping workspace.json overwrite for %s — edited externally; prompting reload', cateDir(rootPath))
          broadcastToAll(WORKSPACE_EXTERNAL_EDIT, { rootPath })
        } else {
          writes.push(atomicWrite(workspacePath(rootPath), wsJson).then(() => rememberWorkspaceContent(rootPath, wsJson)))
        }
        await Promise.all(writes)
        log.debug('Project state saved to %s', cateDir(rootPath))
      })
    },
  )

  ipcMain.handle(PROJECT_STATE_LOAD, async (_event, rootPath: string) => {
    return loadProjectState(rootPath)
  })

  // User dismissed the "reload?" prompt (chose to keep the in-app layout).
  // Drop the tracked hash so the next autosave overwrites the external edit —
  // i.e. resume normal saving with the current canvas winning.
  ipcMain.handle(WORKSPACE_EXTERNAL_EDIT_DISMISS, async (_event, rootPath: string) => {
    lastWrittenWorkspaceHash.delete(rootPath)
  })
}
