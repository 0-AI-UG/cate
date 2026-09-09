import { removedPanelIds, pruneCanvasNodes } from '../shared/pruneRemovedPanels'
import { ipcMain } from 'electron'
import fs from 'fs/promises'
import fsSync from 'fs'
import crypto from 'crypto'
import path from 'path'
import log from './logger'
import { KeyedLock } from './keyedLock'
import {
  PROJECT_STATE_SAVE,
  PROJECT_STATE_LOAD,
  WORKSPACE_EXTERNAL_EDIT,
  WORKSPACE_EXTERNAL_EDIT_DISMISS,
} from '../shared/ipc-channels'
import { holdsProjectLock, acquireProjectLock } from './projectLock'
import { writeTextAtomic, writeTextAtomicSync } from './writeJsonAtomic'
import { isPlainObject } from './jsonUtils'
import { quarantineCorruptFile } from './quarantineCorruptFile'
import type { ProjectWorkspaceFile, ProjectSessionFile } from '../shared/types'
import type { FileAccessContext } from './runtime/types'
import { broadcastToAll, windowFromEvent } from './windowRegistry'
import { ensureCateGitignore, CATE_GITIGNORE_CONTENT } from './cateGitignore'
import { parseLocator, isLocalLocator } from '../shared/runtimeLocator'
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
function workspaceEditedExternallyAsync(rootPath: string, read: () => Promise<string> = () => fs.readFile(workspacePath(rootPath), 'utf-8')): Promise<boolean> {
  const known = lastWrittenWorkspaceHash.get(rootPath)
  if (known === undefined) return Promise.resolve(false)
  return read()
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

// The tmp+rename mechanics live in the shared writeJsonAtomic primitive (which
// uniquifies each tmp as `<file>.<pid>.<seq>.tmp`); these wrappers add the
// `.cate` recovery tier on top: back up the current file by *copying* (not
// renaming) it to `<file>.bak` — so the primary never vanishes if the write
// races a concurrent writer — before renaming the new content into place.
// `.bak` is what the issue #220 prefer-richer load reads.
async function atomicWriteWithBak(filePath: string, json: string): Promise<void> {
  await fs.copyFile(filePath, filePath + '.bak').catch(() => {})
  await writeTextAtomic(filePath, json)
}

function atomicWriteWithBakSync(filePath: string, json: string): void {
  try { fsSync.copyFileSync(filePath, filePath + '.bak') } catch { /* no current file to back up */ }
  writeTextAtomicSync(filePath, json)
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
  const removed = removedPanelIds(data.panels ?? {})
  let count = 0
  for (const canvas of Object.values(canvases)) {
    count += Object.keys(pruneCanvasNodes(canvas.canvasNodes ?? {}, removed)).length
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

// Recovery tiers are primary then .bak. The shared atomic writer never leaves a
// fixed `<file>.tmp` behind — it uniquifies each tmp as `<file>.<pid>.<seq>.tmp`
// — so reading that stale name only ever found nothing.
// When a validator is given, a parseable-but-invalid primary also falls through
// to the .bak tier instead of masking a still-good backup.
async function tryReadWithFallback<T>(filePath: string, isValid?: (v: unknown) => boolean, read: (path: string) => Promise<unknown> = tryReadJson): Promise<T | null> {
  const result = await read(filePath) as T | null
  if (result && (!isValid || isValid(result))) return result
  const bak = await read(filePath + '.bak') as T | null
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

// Workspace-aware read (issue #220): a valid, non-empty primary is authoritative
// even when .bak has more nodes (the difference may be a legitimate deletion).
// Explicitly saved empty layouts are authoritative too. Fall back when the
// primary is invalid or unexpectedly empty, which still recovers the
// original empty-workspace wipe without resurrecting older panels on every load.
async function readWorkspaceWithFallback(filePath: string, read: (path: string) => Promise<unknown> = tryReadJson): Promise<ProjectWorkspaceFile | null> {
  const [primary, backup] = await Promise.all([
    read(filePath),
    read(filePath + '.bak'),
  ])
  if (isValidWorkspace(primary) && (workspaceNodeCount(primary) > 0 || primary.emptyLayout === true)) return primary
  if (isValidWorkspace(backup) && workspaceNodeCount(backup) >= 0) return backup
  return isValidWorkspace(primary) && workspaceNodeCount(primary) >= 0 ? primary : null
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

/** Persist explicit emptiness so recovery does not resurrect the previous layout. */
function withEmptyLayoutIntent(workspace: ProjectWorkspaceFile, allowEmptyLayout: boolean): ProjectWorkspaceFile {
  const { emptyLayout: _previous, ...layout } = workspace
  return allowEmptyLayout && workspaceNodeCount(layout) === 0 ? { ...layout, emptyLayout: true } : layout
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
  allowEmptyLayout = false,
): Promise<void> {
  workspace = withEmptyLayoutIntent(workspace, allowEmptyLayout)
  const wsJson = JSON.stringify(workspace, null, 2)
  const sessJson = JSON.stringify(session, null, 2)
  await enqueueSave(rootPath, async () => {
    await ensureCateGitignore(cateDir(rootPath))
    // session.json is machine-local and never hand-edited, so always write it.
    const writes: Promise<void>[] = [atomicWriteWithBak(sessionPath(rootPath), sessJson)]
    let heldReason: string | undefined
    if (await workspaceEditedExternallyAsync(rootPath)) {
      // Hold the overwrite and ask the renderer to prompt for a reload. The
      // file stays steady until the user reloads or dismisses the prompt.
      log.info('Skipping workspace.json overwrite for %s — edited externally; prompting reload', cateDir(rootPath))
      broadcastToAll(WORKSPACE_EXTERNAL_EDIT, { rootPath })
      heldReason = 'Workspace layout was edited externally; reload or keep the current layout before saving.'
    } else if (!allowEmptyLayout && await wouldEmptyOverwriteWorkspace(rootPath, workspaceNodeCount(workspace))) {
      // Data-loss backstop (issue #220): never overwrite a non-empty saved
      // canvas with an empty one. A renderer-side race while activating a
      // deferred (non-selected) workspace can momentarily serialize an empty
      // canvas; without this guard that empty snapshot clobbers the good
      // workspace.json and the loss is permanent — the empty file is still
      // structurally "valid", so the .bak fallback is never consulted on the
      // next load. This disk-boundary guard is the backstop that also covers
      // deferred/non-selected workspaces serializing a momentarily-empty canvas.
      log.warn('Refusing to overwrite a non-empty canvas with an empty one for %s (issue #220 guard)', cateDir(rootPath))
      heldReason = 'Refusing an empty workspace overwrite while a saved layout exists.'
    } else {
      writes.push(atomicWriteWithBak(workspacePath(rootPath), wsJson).then(() => rememberWorkspaceContent(rootPath, wsJson)))
    }
    await Promise.all(writes)
    if (heldReason) throw new Error(heldReason)
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
const lastSavedProjectStates: Map<string, { workspace: string; session: string; allowEmptyLayout: boolean }> = new Map()

export function saveProjectStateSync(): void {
  for (const [rootPath, { workspace, session, allowEmptyLayout }] of lastSavedProjectStates) {
    try {
      atomicWriteWithBakSync(sessionPath(rootPath), session)
      if (workspaceEditedExternallySync(rootPath)) {
        log.info('Skipping workspace.json sync overwrite for %s — edited externally', cateDir(rootPath))
      } else if (!allowEmptyLayout && wouldEmptyOverwriteWorkspaceSync(rootPath, workspaceNodeCount(JSON.parse(workspace)))) {
        // issue #220 guard: don't let the quit-time fallback flush an empty
        // canvas over a good one (mirrors the async saveProjectStateLocal guard).
        log.warn('Refusing empty workspace.json sync overwrite for %s (issue #220 guard)', cateDir(rootPath))
      } else {
        atomicWriteWithBakSync(workspacePath(rootPath), workspace)
        rememberWorkspaceContent(rootPath, workspace)
      }
    } catch (err) {
      log.warn('Sync project state save failed for %s: %O', rootPath, err)
    }
  }
}

// Serialize saves per root. Overlapping saves race both disk and the remembered
// hash guard, so they share the same keyed queue used by other main-process
// lifecycle managers.
const saveQueues = new KeyedLock()

function enqueueSave(rootPath: string, task: () => Promise<void>): Promise<void> {
  return saveQueues.run(rootPath, task)
}

// ---------------------------------------------------------------------------
// Remote (cate-runtime://) project state.
//
// A remote workspace's tree lives on a runtime, so its `.cate/` files are
// written next to the remote repo THROUGH the runtime file API — the same
// `.cate/workspace.json` + `session.json` layout as local, just over RPC. This
// is what lets remote and local round-trip identically (open/close/reopen).
//
// Runtime writes reuse local validation, backup recovery and layout protection.
// Only the local process lock and synchronous quit fallback stay local: remote
// durability is acknowledged over the runtime's atomic file publication API.
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
  access?: FileAccessContext,
  allowEmptyLayout = false,
): Promise<void> {
  workspace = withEmptyLayoutIntent(workspace, allowEmptyLayout)
  const { runtime, workspaceFile, sessionFile, gitignoreFile } = remoteCateTargets(rootPath)

  const readJson = async (file: string): Promise<unknown> => {
    try { return JSON.parse(await runtime.file.readFile(file, access)) } catch { return null }
  }
  const existing = await readWorkspaceWithFallback(workspaceFile, readJson)
  const preserveLayout = !allowEmptyLayout && workspaceNodeCount(workspace) <= 0 && workspaceNodeCount(existing) > 0

  await runtime.file.stat(gitignoreFile, access)
    .catch(() => runtime.file.writeFile(gitignoreFile, CATE_GITIGNORE_CONTENT, access))

  // Runtime file.writeFile already publishes atomically. Keep a validated last
  // good version for the same recovery policy used by local project files.
  const write = async (file: string, value: unknown, valid: (value: unknown) => boolean): Promise<void> => {
    const previous = await readJson(file)
    if (valid(previous)) await runtime.file.writeFile(file + '.bak', JSON.stringify(previous, null, 2), access)
    await runtime.file.writeFile(file, JSON.stringify(value, null, 2), access)
  }
  await write(sessionFile, session, isValidSession)
  if (await workspaceEditedExternallyAsync(rootPath, () => runtime.file.readFile(workspaceFile, access))) {
    broadcastToAll(WORKSPACE_EXTERNAL_EDIT, { rootPath })
    throw new Error('Workspace layout was edited externally; reload or keep the current layout before saving.')
  } else if (!preserveLayout) {
    await write(workspaceFile, workspace, isValidWorkspace)
    rememberWorkspaceContent(rootPath, JSON.stringify(workspace, null, 2))
  } else {
    throw new Error('Refusing an empty workspace overwrite while a saved layout exists.')
  }
  log.debug('Remote project state saved to %s', rootPath)
}

async function loadProjectStateRemote(rootPath: string, access?: FileAccessContext): Promise<{
  workspace: ProjectWorkspaceFile
  session: ProjectSessionFile | null
} | null> {
  const { runtime, workspaceFile, sessionFile } = remoteCateTargets(rootPath)
  const readJson = async (file: string): Promise<unknown> => {
    try { return JSON.parse(await runtime.file.readFile(file, access)) } catch { return null }
  }
  const workspace = await readWorkspaceWithFallback(workspaceFile, readJson)
  if (!workspace) return null
  await runtime.file.readFile(workspaceFile, access)
    .then(raw => rememberWorkspaceContent(rootPath, raw)).catch(() => {})
  const session = await tryReadWithFallback<ProjectSessionFile>(sessionFile, isValidSession, readJson)
  return { workspace, session }
}

export function registerProjectStateHandlers(): void {
  ipcMain.handle(
    PROJECT_STATE_SAVE,
    async (event, rootPath: string, workspace: ProjectWorkspaceFile, session: ProjectSessionFile, workspaceId?: string, options?: { allowEmptyLayout?: boolean }) => {
      workspace = withEmptyLayoutIntent(workspace, options?.allowEmptyLayout === true)
      // Remote workspaces use the same session policy with scoped runtime I/O;
      // the local process lock and synchronous fallback cannot apply over RPC.
      if (!isLocalLocator(rootPath)) {
        const access = { ownerWindowId: windowFromEvent(event)?.id, scopeId: workspaceId }
        return enqueueSave(rootPath, () => saveProjectStateRemote(rootPath, workspace, session, access, options?.allowEmptyLayout === true))
      }
      const wsJson = JSON.stringify(workspace, null, 2)
      const sessJson = JSON.stringify(session, null, 2)
      lastSavedProjectStates.set(rootPath, { workspace: wsJson, session: sessJson, allowEmptyLayout: options?.allowEmptyLayout === true })
      // If another live Cate instance owns this project, don't autosave over
      // it — that's the two-writers loop. Re-acquire each time so we resume
      // saving once the owner exits; only skip while it's genuinely held.
      if (!holdsProjectLock(rootPath) && !acquireProjectLock(rootPath)) {
        log.debug('Skipping save for %s — another Cate instance owns it', cateDir(rootPath))
        lastSavedProjectStates.delete(rootPath) // keep the quit-time sync fallback out too
        throw new Error('Cannot acquire the project save lock: another Cate instance owns it or the .cate directory is inaccessible.')
      }
      await saveProjectStateLocal(rootPath, workspace, session, options?.allowEmptyLayout === true)
    },
  )

  ipcMain.handle(PROJECT_STATE_LOAD, async (event, rootPath: string, workspaceId?: string) => {
    return isLocalLocator(rootPath) ? loadProjectState(rootPath) : loadProjectStateRemote(rootPath, { ownerWindowId: windowFromEvent(event)?.id, scopeId: workspaceId })
  })

  // User dismissed the "reload?" prompt (chose to keep the in-app layout).
  // Drop the tracked hash so the next autosave overwrites the external edit —
  // i.e. resume normal saving with the current canvas winning.
  ipcMain.handle(WORKSPACE_EXTERNAL_EDIT_DISMISS, async (_event, rootPath: string) => {
    lastWrittenWorkspaceHash.delete(rootPath)
  })
}
