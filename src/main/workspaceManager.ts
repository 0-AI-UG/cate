// =============================================================================
// Workspace Manager — main-process source of truth for workspace metadata.
//
// Stores WorkspaceInfo[] (id, name, color, rootPath).
// Canvas/panel state lives in each renderer window — only metadata is shared.
// =============================================================================

import { ipcMain } from 'electron'
import log from './logger'
import {
  WORKSPACE_LIST,
  WORKSPACE_CREATE,
  WORKSPACE_UPDATE,
  WORKSPACE_REMOVE,
  WORKSPACE_GET,
  WORKSPACE_CHANGED,
} from '../shared/ipc-channels'
import type { WorkspaceInfo } from '../shared/types'
import { broadcastToAll, windowFromEvent } from './windowRegistry'
import { addAllowedRoot } from './ipc/pathValidation'

// In-memory workspace list — authoritative source of truth
const workspaces: Map<string, WorkspaceInfo> = new Map()

// Accent colors cycled for new workspaces
const WORKSPACE_COLORS = [
  '#0080ff', // pure blue
  '#ff8000', // pure orange
  '#00e000', // pure green
  '#aa00ff', // pure violet
  '#ff0000', // pure red
  '#00e0e0', // pure cyan
]
let colorIndex = 0

function nextColor(): string {
  const color = WORKSPACE_COLORS[colorIndex % WORKSPACE_COLORS.length]
  colorIndex++
  return color
}

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

// -----------------------------------------------------------------------------
// Public API (called by IPC handlers)
// -----------------------------------------------------------------------------

function listWorkspaces(): WorkspaceInfo[] {
  return Array.from(workspaces.values())
}

function getWorkspace(id: string): WorkspaceInfo | null {
  return workspaces.get(id) ?? null
}

function createWorkspace(name?: string, rootPath?: string, id?: string): WorkspaceInfo {
  const info: WorkspaceInfo = {
    id: id ?? generateId(),
    name: name ?? 'Workspace',
    color: nextColor(),
    rootPath: rootPath ?? '',
  }
  workspaces.set(info.id, info)
  log.info('Workspace created: %s (%s)', info.id, info.rootPath || 'no root')
  // Register workspace root as an allowed path for filesystem/git access
  if (info.rootPath) {
    addAllowedRoot(info.rootPath)
  }
  return info
}

function updateWorkspace(id: string, changes: Partial<Omit<WorkspaceInfo, 'id'>>): WorkspaceInfo | null {
  const existing = workspaces.get(id)
  if (!existing) return null
  const updated = { ...existing, ...changes }
  workspaces.set(id, updated)
  // Register updated workspace root as an allowed path
  if (updated.rootPath) {
    addAllowedRoot(updated.rootPath)
  }
  return updated
}

function removeWorkspace(id: string): boolean {
  const removed = workspaces.delete(id)
  if (removed) log.info('Workspace removed: %s', id)
  return removed
}

// -----------------------------------------------------------------------------
// Broadcast helper — notify all windows of workspace list change
// -----------------------------------------------------------------------------

function broadcastWorkspaceChange(originWindowId?: number): void {
  broadcastToAll(WORKSPACE_CHANGED, listWorkspaces(), originWindowId ?? null)
}

// -----------------------------------------------------------------------------
// IPC handler registration
// -----------------------------------------------------------------------------

export function registerWorkspaceHandlers(): void {
  // List all workspaces
  ipcMain.handle(WORKSPACE_LIST, async () => {
    return listWorkspaces()
  })

  // Get a single workspace by ID
  ipcMain.handle(WORKSPACE_GET, async (_event, id: string) => {
    return getWorkspace(id)
  })

  // Create a new workspace
  ipcMain.handle(
    WORKSPACE_CREATE,
    async (event, options?: { name?: string; rootPath?: string; id?: string }) => {
      const info = createWorkspace(options?.name, options?.rootPath, options?.id)
      const win = windowFromEvent(event)
      broadcastWorkspaceChange(win?.id)
      return info
    },
  )

  // Update workspace metadata
  ipcMain.handle(
    WORKSPACE_UPDATE,
    async (event, id: string, changes: Partial<Omit<WorkspaceInfo, 'id'>>) => {
      const updated = updateWorkspace(id, changes)
      if (updated) {
        const win = windowFromEvent(event)
        broadcastWorkspaceChange(win?.id)
      }
      return updated
    },
  )

  // Remove a workspace
  ipcMain.handle(WORKSPACE_REMOVE, async (event, id: string) => {
    const removed = removeWorkspace(id)
    if (removed) {
      const win = windowFromEvent(event)
      broadcastWorkspaceChange(win?.id)
    }
    return removed
  })
}
