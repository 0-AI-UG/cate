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
import { isPlainObject } from './jsonUtils'
import { quarantineCorruptFile } from './quarantineCorruptFile'
import type { ProjectWorkspaceFile, ProjectSessionFile } from '../shared/types'
import { toRelativePath } from '../shared/pathUtils'
import { broadcastToAll } from './windowRegistry'
import { ensureCateGitignore, CATE_GITIGNORE_CONTENT } from './cateGitignore'
import { parseLocator, isLocalLocator } from './runtime/locator'
import { runtimes } from './runtime/runtimeManager'

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
  let data: string
  try {
    data = await fs.readFile(filePath, 'utf-8')
  } catch {
    return null
  }
  try {
    return JSON.parse(data) as T
  } catch {
    // The file exists but is unparseable: quarantine it so the broken content
    // survives for recovery (the .bak tier handles the actual load fallback).
    const backup = quarantineCorruptFile(filePath)
    log.warn('Corrupt JSON at %s%s; ignoring', filePath, backup ? `, backed up to ${backup}` : '')
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
// issue #220 data-loss footgun. The async variant reads the richest of
// primary/.bak so a momentarily-empty primary still counts the .bak's nodes;
// the sync variant keeps the quit-time fallback (saveProjectStateSync) honest
// without an await.
async function wouldEmptyOverwriteWorkspace(rootPath: string, incomingNodeCount: number): Promise<boolean> {
  if (incomingNodeCount > 0) return false
  const existing = await readWorkspaceWithFallback(workspacePath(rootPath))
  return workspaceNodeCount(existing) > 0
}

function wouldEmptyOverwriteWorkspaceSync(rootPath: string, incomingNodeCount: number): boolean {
  if (incomingNodeCount > 0) return false
  try {
    const existing = JSON.parse(fsSync.readFileSync(workspacePath(rootPath), 'utf-8'))
    if (workspaceNodeCount(existing) > 0) return true
  } catch {
    /* primary missing/corrupt — fall through to the .bak check */
  }
  // The primary may already have been emptied by an earlier live write; the
  // rich canvas survives in .bak. Consult it so the quit-time flush never
  // copies an empty primary over a good .bak.
  try {
    const bak = JSON.parse(fsSync.readFileSync(workspacePath(rootPath) + '.bak', 'utf-8'))
    return workspaceNodeCount(bak) > 0
  } catch {
    return false
  }
}

// Recovery tiers are primary then .bak. The writers (atomicWrite/atomicWriteSync)
// no longer leave a fixed `<file>.tmp` behind — they uniquify each tmp as
// `<file>.<pid>.<seq>.tmp` — so reading that stale name only ever found nothing.
// When a validator is given, a parseable-but-invalid primary also falls through
// to the .bak tier instead of masking a still-good backup.
async function tryReadWithFallback<T>(filePath: string, isValid?: (v: unknown) => boolean): Promise<T | null> {
  const result = await tryReadJson<T>(filePath)
  if (result && (!isValid || isValid(result))) return result
  const bak = await tryReadJson<T>(filePath + '.bak')
  if (bak && (!isValid || isValid(bak))) return bak
  return null
}

// Sweep orphaned `<file>.<pid>.<seq>.tmp` files next to `filePath`. A crash
// between writeFile and rename can leave these behind; they're never re-read
// (recovery is primary/.bak), so left alone they'd accumulate forever.
async function cleanOrphanedTmpFiles(filePath: string): Promise<void> {
  const dir = path.dirname(filePath)
  const base = path.basename(filePath)
  const tmpPattern = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.\\d+\\.\\d+\\.tmp$`)
  try {
    const entries = await fs.readdir(dir)
    await Promise.all(
      entries
        .filter((name) => tmpPattern.test(name))
        .map((name) => fs.unlink(path.join(dir, name)).catch(() => {})),
    )
  } catch {
    /* dir gone or unreadable — nothing to sweep */
  }
}

// Workspace-aware read (issue #220): the plain primary file can be a valid but
// *empty* canvas left behind by a wipe. When that happens, prefer the richer of
// primary / .bak so a previously-wiped workspace still recovers its panels on
// the next load instead of perpetuating the empty state.
async function readWorkspaceWithFallback(filePath: string): Promise<ProjectWorkspaceFile | null> {
  const candidates = await Promise.all([
    tryReadJson<ProjectWorkspaceFile>(filePath),
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
  if (!isPlainObject(data)) return false
  // workspace.json carries the shareable name/color; session.json does not —
  // that's what tells the two version-1 files apart.
  if (data.version !== 1 || typeof data.name !== 'string' || typeof data.color !== 'string') return false
  // workspace.json is committable and hand-editable, so also check the container
  // shapes the restore code dereferences. A structurally broken file degrades to
  // the .bak tier instead of flowing malformed entries into the renderer (or
  // crashing workspaceNodeCount on e.g. a null canvases entry).
  if (data.dockState !== undefined) {
    if (!isPlainObject(data.dockState) || !isPlainObject(data.dockState.zones)) return false
  }
  if (data.panels !== undefined) {
    if (!isPlainObject(data.panels)) return false
    for (const ref of Object.values(data.panels)) {
      if (!isPlainObject(ref) || typeof ref.type !== 'string') return false
    }
  }
  if (data.canvases !== undefined) {
    if (!isPlainObject(data.canvases)) return false
    for (const canvas of Object.values(data.canvases)) {
      if (!isPlainObject(canvas)) return false
      if (canvas.canvasNodes !== undefined && !isPlainObject(canvas.canvasNodes)) return false
    }
  }
  return true
}

function isValidSession(data: unknown): data is ProjectSessionFile {
  if (!isPlainObject(data)) return false
  if (data.version !== 1 || !isPlainObject(data.panels)) return false
  for (const panel of Object.values(data.panels)) {
    if (!isPlainObject(panel)) return false
  }
  if (data.dockWindows !== undefined) {
    if (!Array.isArray(data.dockWindows)) return false
    for (const dw of data.dockWindows) {
      if (!isPlainObject(dw) || !isPlainObject(dw.panels)) return false
    }
  }
  if (data.worktrees !== undefined && !Array.isArray(data.worktrees)) return false
  return true
}

// Core local save: serializes the per-root write and applies both disk-boundary
// guards (external-edit + issue #220 empty-overwrite) before touching
// workspace.json. The live PROJECT_STATE_SAVE handler is the only caller; it
// records `lastSavedProjectStates` / acquires the project lock first, then
// hands the queued write here. Exposed for the production-path tests.
export async function saveProjectStateLocal(
  rootPath: string,
  workspace: ProjectWorkspaceFile,
  session: ProjectSessionFile,
): Promise<void> {
  const wsJson = JSON.stringify(workspace, null, 2)
  const sessJson = JSON.stringify(session, null, 2)
  await enqueueSave(rootPath, async () => {
    await ensureCateGitignore(cateDir(rootPath))
    // session.json is machine-local and never hand-edited, so always write it.
    const writes: Promise<void>[] = [atomicWrite(sessionPath(rootPath), sessJson)]
    if (await workspaceEditedExternallyAsync(rootPath)) {
      // Hold the overwrite and ask the renderer to prompt for a reload. The
      // file stays steady until the user reloads or dismisses the prompt.
      log.info('Skipping workspace.json overwrite for %s — edited externally; prompting reload', cateDir(rootPath))
      broadcastToAll(WORKSPACE_EXTERNAL_EDIT, { rootPath })
    } else if (await wouldEmptyOverwriteWorkspace(rootPath, workspaceNodeCount(workspace))) {
      // Data-loss backstop (issue #220): never overwrite a non-empty saved
      // canvas with an empty one. A renderer-side race while activating a
      // deferred (non-selected) workspace can momentarily serialize an empty
      // canvas; without this guard that empty snapshot clobbers the good
      // workspace.json and the loss is permanent — the empty file is still
      // structurally "valid", so the .bak fallback is never consulted on the
      // next load. This disk-boundary guard is the backstop that also covers
      // deferred/non-selected workspaces serializing a momentarily-empty canvas.
      log.warn('Refusing to overwrite a non-empty canvas with an empty one for %s (issue #220 guard)', cateDir(rootPath))
    } else {
      writes.push(atomicWrite(workspacePath(rootPath), wsJson).then(() => rememberWorkspaceContent(rootPath, wsJson)))
    }
    await Promise.all(writes)
    log.debug('Project state saved to %s', cateDir(rootPath))
  })
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
  const sess = await tryReadWithFallback<ProjectSessionFile>(sessionPath(rootPath), isValidSession)
  // Sweep any orphaned tmp files a crashed write may have left behind.
  await Promise.all([
    cleanOrphanedTmpFiles(workspacePath(rootPath)),
    cleanOrphanedTmpFiles(sessionPath(rootPath)),
  ])
  return {
    workspace: ws,
    session: sess,
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
        // canvas over a good one (mirrors the async saveProjectStateLocal guard).
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

// ---------------------------------------------------------------------------
// Remote (cate-runtime://) project state.
//
// A remote workspace's tree lives on a runtime, so its `.cate/` files are
// written next to the remote repo THROUGH the runtime file API — the same
// `.cate/workspace.json` + `session.json` layout as local, just over RPC. This
// is what lets remote and local round-trip identically (open/close/reopen).
//
// The local-only machinery does NOT apply here: there's no sync quit-time path
// over an async RPC, the project lock guards local multi-instance writes, and
// the external-edit SHA guard is tied to the local chokidar watcher. Remote
// keeps the data-loss backstop (don't clobber a non-empty canvas with an empty
// one) and writes the same `.cate/.gitignore`.
// ---------------------------------------------------------------------------

function remoteCateTargets(rootPath: string) {
  const { runtimeId, path: base } = parseLocator(rootPath)
  const dir = path.posix.join(base, CATE_DIR)
  return {
    runtime: runtimes.resolve(runtimeId),
    cateDir: dir,
    workspaceFile: path.posix.join(dir, WORKSPACE_FILE),
    sessionFile: path.posix.join(dir, SESSION_FILE),
    gitignoreFile: path.posix.join(dir, '.gitignore'),
  }
}

async function saveProjectStateRemote(
  rootPath: string,
  workspace: ProjectWorkspaceFile,
  session: ProjectSessionFile,
): Promise<void> {
  const { runtime, workspaceFile, sessionFile, gitignoreFile } = remoteCateTargets(rootPath)

  // Data-loss backstop (issue #220), mirrored for remote: never overwrite a
  // non-empty saved canvas with an empty one.
  if (workspaceNodeCount(workspace) <= 0) {
    const existing = await runtime.file
      .readFile(workspaceFile)
      .then((raw) => JSON.parse(raw) as unknown)
      .catch(() => null)
    if (workspaceNodeCount(existing) > 0) {
      log.warn('Refusing to overwrite remote %s with an empty canvas (issue #220 guard)', workspaceFile)
      return
    }
  }

  // Write-once .gitignore so committable workspace.json is the only shared file.
  await runtime.file
    .stat(gitignoreFile)
    .catch(() => runtime.file.writeFile(gitignoreFile, CATE_GITIGNORE_CONTENT))

  await Promise.all([
    runtime.file.writeFile(workspaceFile, JSON.stringify(workspace, null, 2)),
    runtime.file.writeFile(sessionFile, JSON.stringify(session, null, 2)),
  ])
  log.debug('Remote project state saved to %s', rootPath)
}

async function loadProjectStateRemote(rootPath: string): Promise<{
  workspace: ProjectWorkspaceFile
  session: ProjectSessionFile | null
} | null> {
  const { runtime, workspaceFile, sessionFile } = remoteCateTargets(rootPath)
  const wsRaw = await runtime.file.readFile(workspaceFile).catch(() => null)
  if (!wsRaw) return null
  let ws: unknown
  try {
    ws = JSON.parse(wsRaw)
  } catch {
    return null
  }
  if (!isValidWorkspace(ws)) return null

  const sessRaw = await runtime.file.readFile(sessionFile).catch(() => null)
  let sess: ProjectSessionFile | null = null
  if (sessRaw) {
    try {
      const parsed = JSON.parse(sessRaw)
      if (isValidSession(parsed)) sess = parsed
    } catch {
      /* malformed session.json — fall back to no session */
    }
  }
  return { workspace: ws, session: sess }
}

export function registerProjectStateHandlers(): void {
  ipcMain.handle(
    PROJECT_STATE_SAVE,
    async (_event, rootPath: string, workspace: ProjectWorkspaceFile, session: ProjectSessionFile) => {
      // Remote workspaces save `.cate/` on their runtime. No local lock,
      // sync-fallback, or external-edit guard applies; just serialize per root.
      if (!isLocalLocator(rootPath)) {
        return enqueueSave(rootPath, () =>
          saveProjectStateRemote(rootPath, workspace, session).catch((err) =>
            log.warn('Remote project state save failed for %s: %O', rootPath, err),
          ),
        )
      }
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
      await saveProjectStateLocal(rootPath, workspace, session)
    },
  )

  ipcMain.handle(PROJECT_STATE_LOAD, async (_event, rootPath: string) => {
    return isLocalLocator(rootPath) ? loadProjectState(rootPath) : loadProjectStateRemote(rootPath)
  })

  // User dismissed the "reload?" prompt (chose to keep the in-app layout).
  // Drop the tracked hash so the next autosave overwrites the external edit —
  // i.e. resume normal saving with the current canvas winning.
  ipcMain.handle(WORKSPACE_EXTERNAL_EDIT_DISMISS, async (_event, rootPath: string) => {
    lastWrittenWorkspaceHash.delete(rootPath)
  })
}
