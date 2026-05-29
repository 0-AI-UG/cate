import { ipcMain, app } from 'electron'
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
import type { ProjectWorkspaceFile, ProjectSessionFile, MultiWorkspaceSession, SessionSnapshot, DockLayoutNode, WindowDockState } from '../shared/types'
import { toRelativePath } from '../shared/pathUtils'
import { broadcastToAll } from './windowRegistry'

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
// workspace.json is committable and meant to be hand- or agent-edited (e.g. via
// the .cate skill) to reconfigure the canvas. But the renderer also autosaves
// the live layout back over it (~30s + on quit), which would clobber any edit
// made while the app is running. To prevent that, we remember the hash of the
// content we last wrote/read per project; before any autosave overwrite we
// compare it against what's on disk. A mismatch means the file was edited
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

async function atomicWrite(filePath: string, json: string): Promise<void> {
  const dir = path.dirname(filePath)
  const tmpPath = filePath + '.tmp'
  const bakPath = filePath + '.bak'

  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(tmpPath, json, 'utf-8')
  const stat = await fs.stat(tmpPath)
  if (stat.size === 0) {
    await fs.unlink(tmpPath).catch(() => {})
    throw new Error('tmp file is empty after write')
  }
  await fs.rename(filePath, bakPath).catch(() => {})
  await fs.rename(tmpPath, filePath)
}

function atomicWriteSync(filePath: string, json: string): void {
  const dir = path.dirname(filePath)
  const tmpPath = filePath + '.tmp'
  const bakPath = filePath + '.bak'

  fsSync.mkdirSync(dir, { recursive: true })
  fsSync.writeFileSync(tmpPath, json, 'utf-8')
  const stat = fsSync.statSync(tmpPath)
  if (stat.size === 0) {
    throw new Error('tmp file is empty after write')
  }
  try { fsSync.renameSync(filePath, bakPath) } catch { /* OK */ }
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

async function tryReadWithFallback<T>(filePath: string): Promise<T | null> {
  const result = await tryReadJson<T>(filePath)
  if (result) return result
  const tmp = await tryReadJson<T>(filePath + '.tmp')
  if (tmp) return tmp
  return tryReadJson<T>(filePath + '.bak')
}

function isValidWorkspace(data: unknown): data is ProjectWorkspaceFile {
  if (!data || typeof data !== 'object') return false
  const obj = data as Record<string, unknown>
  return obj.version === 1 && obj.canvas != null && typeof obj.canvas === 'object'
}

function isValidSession(data: unknown): data is ProjectSessionFile {
  if (!data || typeof data !== 'object') return false
  const obj = data as Record<string, unknown>
  return obj.version === 1 && obj.nodes != null
}

export async function saveProjectState(
  rootPath: string,
  workspace: ProjectWorkspaceFile,
  session: ProjectSessionFile,
): Promise<void> {
  const wsJson = JSON.stringify(workspace, null, 2)
  const sessJson = JSON.stringify(session, null, 2)
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
  const ws = await tryReadWithFallback<ProjectWorkspaceFile>(workspacePath(rootPath))
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
let lastSavedProjectStates: Map<string, { workspace: string; session: string }> = new Map()

export function saveProjectStateSync(): void {
  for (const [rootPath, { workspace, session }] of lastSavedProjectStates) {
    try {
      atomicWriteSync(sessionPath(rootPath), session)
      if (workspaceEditedExternallySync(rootPath)) {
        log.info('Skipping workspace.json sync overwrite for %s — edited externally', cateDir(rootPath))
      } else {
        atomicWriteSync(workspacePath(rootPath), workspace)
        rememberWorkspaceContent(rootPath, workspace)
      }
    } catch (err) {
      log.warn('Sync project state save failed for %s: %O', rootPath, err)
    }
  }
}

// MIGRATION: Legacy Sessions/session.json → .cate/ per-project files.
// Safe to delete runLegacyMigrationIfNeeded, snapshotToWorkspaceFile,
// snapshotToSessionFile, and the collectPanelIds helpers once all users
// have launched at least once on a version that includes this migration.

export async function runLegacyMigrationIfNeeded(): Promise<void> {
  const legacySessionDir = path.join(app.getPath('userData'), 'Sessions')
  const legacySessionPath = path.join(legacySessionDir, 'session.json')

  let legacyData: MultiWorkspaceSession | null = null
  try {
    const raw = await fs.readFile(legacySessionPath, 'utf-8')
    const parsed = JSON.parse(raw)
    if (parsed?.version === 2 && Array.isArray(parsed.workspaces)) {
      legacyData = parsed as MultiWorkspaceSession
    }
  } catch {
    return
  }

  if (!legacyData) return

  let migrated = 0
  for (const snapshot of legacyData.workspaces) {
    if (!snapshot.rootPath) continue
    const existing = await tryReadJson(workspacePath(snapshot.rootPath))
    if (existing) continue

    const workspace = snapshotToWorkspaceFile(snapshot)
    const session = snapshotToSessionFile(snapshot)
    try {
      await saveProjectState(snapshot.rootPath, workspace, session)
      migrated++
      log.info('[migration] Converted legacy session for %s', snapshot.rootPath)
    } catch (err) {
      log.warn('[migration] Failed for %s: %O', snapshot.rootPath, err)
    }
  }

  // Rename legacy files so this path is never hit again
  const suffixes = ['', '.tmp', '.bak']
  for (const suffix of suffixes) {
    const src = legacySessionPath + suffix
    await fs.rename(src, src + '.migrated').catch(() => {})
  }

  log.info('[migration] Legacy session migration complete (%d workspaces converted)', migrated)
}

function snapshotToWorkspaceFile(snapshot: SessionSnapshot): ProjectWorkspaceFile {
  const rootPath = snapshot.rootPath || ''
  const regions = snapshot.regions
    ? Object.values(snapshot.regions).map((r) => ({
        id: r.id,
        origin: r.origin,
        size: r.size,
        label: r.label,
        color: r.color,
        zOrder: r.zOrder,
      }))
    : []

  const nodes = snapshot.nodes.map((n) => {
    let regionId = n.regionId
    // Auto-assign regionId for nodes from pre-region sessions
    if (!regionId && regions.length > 0) {
      for (const r of regions) {
        const overlapX = Math.max(0, Math.min(n.origin.x + n.size.width, r.origin.x + r.size.width) - Math.max(n.origin.x, r.origin.x))
        const overlapY = Math.max(0, Math.min(n.origin.y + n.size.height, r.origin.y + r.size.height) - Math.max(n.origin.y, r.origin.y))
        if (n.size.width * n.size.height > 0 && (overlapX * overlapY) / (n.size.width * n.size.height) > 0.5) {
          regionId = r.id
          break
        }
      }
    }
    return {
      panelId: n.panelId,
      panelType: n.panelType,
      title: n.title,
      origin: n.origin,
      size: n.size,
      filePath: n.filePath ? toRelativePath(n.filePath, rootPath) : undefined,
      url: n.url ?? undefined,
      regionId,
      documentType: n.documentType,
    }
  })

  // Derive dockPanels from dockState for sessions saved before dockPanels existed
  let dockPanels: ProjectWorkspaceFile['dockPanels']
  if (snapshot.dockPanels) {
    dockPanels = Object.fromEntries(
      Object.entries(snapshot.dockPanels).map(([id, p]) => [
        id,
        {
          type: p.type,
          title: p.title,
          filePath: p.filePath ? toRelativePath(p.filePath, rootPath) : undefined,
          url: p.url ?? undefined,
        },
      ]),
    )
  } else if (snapshot.dockState) {
    const panelIds = collectPanelIdsFromZones(snapshot.dockState.zones)
    const canvasNodeIds = new Set(snapshot.nodes.map((n) => n.panelId))
    dockPanels = {}
    for (const id of panelIds) {
      if (!canvasNodeIds.has(id)) {
        dockPanels[id] = { type: 'canvas', title: 'Canvas' }
      }
    }
  }

  return {
    version: 1,
    name: snapshot.workspaceName,
    color: '',
    canvas: { nodes, regions, zoomLevel: snapshot.zoomLevel, viewportOffset: snapshot.viewportOffset },
    dockState: snapshot.dockState,
    dockPanels,
  }
}

function collectPanelIdsFromZones(zones: WindowDockState): string[] {
  const ids: string[] = []
  for (const zone of Object.values(zones)) {
    if (zone.layout) collectPanelIdsFromNode(zone.layout, ids)
  }
  return ids
}

function collectPanelIdsFromNode(node: DockLayoutNode, ids: string[]): void {
  if (node.type === 'tabs') {
    ids.push(...node.panelIds)
  } else {
    for (const child of node.children) {
      collectPanelIdsFromNode(child, ids)
    }
  }
}

function snapshotToSessionFile(snapshot: SessionSnapshot): ProjectSessionFile {
  const nodes: Record<string, { panelId: string; zOrder: number; creationIndex: number; ptyId?: string; workingDirectory?: string; unsavedContent?: string }> = {}
  snapshot.nodes.forEach((n, i) => {
    nodes[n.panelId] = {
      panelId: n.panelId,
      zOrder: i,
      creationIndex: i,
      ptyId: n.ptyId,
      workingDirectory: n.workingDirectory ?? undefined,
      unsavedContent: n.unsavedContent,
    }
  })
  return {
    version: 1,
    focusedNodeId: null,
    nodes,
  }
}

const SKILL_FILE = 'skill.md'
const seededSkillRoots = new Set<string>()

async function seedSkillFile(rootPath: string): Promise<void> {
  if (seededSkillRoots.has(rootPath)) return
  seededSkillRoots.add(rootPath)
  const skillPath = path.join(rootPath, CATE_DIR, SKILL_FILE)
  try {
    await fs.access(skillPath)
  } catch {
    try {
      const { SKILL_TEMPLATE } = await import('./templates/skillTemplate')
      await fs.writeFile(skillPath, SKILL_TEMPLATE, 'utf-8')
      log.debug('Seeded skill.md in %s', cateDir(rootPath))
    } catch (err) {
      log.warn('Failed to seed skill.md: %O', err)
    }
  }
}

export function registerProjectStateHandlers(): void {
  ipcMain.handle(
    PROJECT_STATE_SAVE,
    async (_event, rootPath: string, workspace: ProjectWorkspaceFile, session: ProjectSessionFile) => {
      const wsJson = JSON.stringify(workspace, null, 2)
      const sessJson = JSON.stringify(session, null, 2)
      lastSavedProjectStates.set(rootPath, { workspace: wsJson, session: sessJson })
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
      seedSkillFile(rootPath).catch(() => {})
      log.debug('Project state saved to %s', cateDir(rootPath))
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
