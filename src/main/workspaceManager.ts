// =============================================================================
// Workspace Manager — main-process source of truth for workspace metadata.
//
// Stores WorkspaceInfo[] (id, name, color, rootPath).
// Canvas/panel state lives in each renderer window — only metadata is shared.
// =============================================================================

import { ipcMain, dialog } from 'electron'
import { randomUUID } from 'crypto'
import log from './logger'
import {
  WORKSPACE_CREATE,
  WORKSPACE_UPDATE,
  WORKSPACE_REMOVE,
  WORKSPACE_CHANGED,
} from '../shared/ipc-channels'
import type { WorkspaceInfo, WorkspaceMutationResult } from '../shared/types'
import { broadcastToAll, windowFromEvent } from './windowRegistry'
import { addAllowedRoot, removeAllowedRoot } from './ipc/pathValidation'
import { resolveTrustedWorkspaceRoot } from './workspaceRoots'
import { acquireProjectLock, releaseProjectLock } from './projectLock'

// In-memory workspace list — authoritative source of truth
const workspaces: Map<string, WorkspaceInfo> = new Map()

// ---------------------------------------------------------------------------
// Security helpers
// ---------------------------------------------------------------------------

/** Accepts standard UUIDs (from randomUUID) and any safe alphanumeric id. */
const WORKSPACE_ID_RE = /^[a-zA-Z0-9_-]{8,64}$/

function isValidWorkspaceId(id: string): boolean {
  return WORKSPACE_ID_RE.test(id)
}

function generateId(): string {
  return randomUUID()
}

// -----------------------------------------------------------------------------
// Per-project lock — claim ownership of a project's .cate/workspace.json when
// it's opened here, so a second Cate (dev vs installed) won't autosave over us.
// -----------------------------------------------------------------------------

/** True if any workspace other than `exceptId` is rooted at `rootPath`. */
function rootInUse(rootPath: string, exceptId?: string): boolean {
  for (const [id, w] of workspaces) {
    if (id === exceptId) continue
    if (w.rootPath === rootPath) return true
  }
  return false
}

/** Claim the lock for a root; if a live instance already owns it, warn that
 *  layout changes here won't be saved (autosave is suppressed for it). */
function claimProjectLock(rootPath: string, name?: string): void {
  if (!rootPath) return
  if (acquireProjectLock(rootPath)) return
  void dialog.showMessageBox({
    type: 'warning',
    message: 'Another Cate instance has this project open',
    detail: `Changes you make to the workspace${name ? ` "${name}"` : ''} won't be saved while another Cate instance has it open. Close the other instance to resume saving.`,
    buttons: ['OK'],
    noLink: true,
  })
}

/** Drop the project lock once no remaining workspace here uses that root. */
function dropProjectLock(rootPath: string, exceptId?: string): void {
  if (!rootPath || rootInUse(rootPath, exceptId)) return
  releaseProjectLock(rootPath)
}

// -----------------------------------------------------------------------------
// Public API (called by IPC handlers)
// -----------------------------------------------------------------------------

function listWorkspaces(): WorkspaceInfo[] {
  return Array.from(workspaces.values())
}

async function createWorkspace(name?: string, rootPath?: string, id?: string): Promise<WorkspaceMutationResult> {
  // Validate caller-supplied id; fall back to a fresh UUID if invalid.
  const resolvedId = id && isValidWorkspaceId(id) ? id : generateId()
  if (id && resolvedId !== id) {
    log.warn('workspaceManager: invalid workspace id supplied, generating new one (supplied: %s)', id)
  }

  let trustedRoot = ''
  if (rootPath) {
    const resolvedRoot = await resolveTrustedWorkspaceRoot(rootPath)
    if (!resolvedRoot) {
      return {
        ok: false,
        error: {
          code: 'INVALID_ROOT_PATH',
          message: `Workspace root is not a readable directory: ${rootPath}`,
        },
      }
    }
    trustedRoot = resolvedRoot
  }

  const info: WorkspaceInfo = {
    id: resolvedId,
    name: name ?? 'Workspace',
    color: '',
    rootPath: trustedRoot,
  }
  workspaces.set(info.id, info)
  log.info('Workspace created: %s (%s)', info.id, info.rootPath || 'no root')
  if (info.rootPath) {
    addAllowedRoot(info.rootPath)
    claimProjectLock(info.rootPath, info.name)
  }
  return { ok: true, workspace: info }
}

async function updateWorkspace(id: string, changes: Partial<Omit<WorkspaceInfo, 'id'>>): Promise<WorkspaceMutationResult> {
  if (!isValidWorkspaceId(id)) {
    log.warn('workspaceManager: updateWorkspace called with invalid id: %s', id)
    return {
      ok: false,
      error: {
        code: 'INVALID_WORKSPACE_ID',
        message: `Workspace id is invalid: ${id}`,
      },
    }
  }
  const existing = workspaces.get(id)
  if (!existing) {
    return {
      ok: false,
      error: {
        code: 'WORKSPACE_NOT_FOUND',
        message: `Workspace not found: ${id}`,
      },
    }
  }

  let nextRootPath = existing.rootPath
  if (typeof changes.rootPath === 'string') {
    if (!changes.rootPath) {
      nextRootPath = ''
    } else {
      const resolvedRoot = await resolveTrustedWorkspaceRoot(changes.rootPath)
      if (!resolvedRoot) {
        return {
          ok: false,
          error: {
            code: 'INVALID_ROOT_PATH',
            message: `Workspace root is not a readable directory: ${changes.rootPath}`,
          },
        }
      }
      nextRootPath = resolvedRoot
    }
  }

  const rootChanged = existing.rootPath !== nextRootPath
  if (existing.rootPath && rootChanged) {
    removeAllowedRoot(existing.rootPath)
  }

  const updated = { ...existing, ...changes, rootPath: nextRootPath }
  workspaces.set(id, updated)
  if (updated.rootPath) {
    addAllowedRoot(updated.rootPath)
  }
  if (rootChanged) {
    // Release the lock on the old root (if no sibling workspace still uses it)
    // and claim the new one.
    if (existing.rootPath) dropProjectLock(existing.rootPath, id)
    if (updated.rootPath) claimProjectLock(updated.rootPath, updated.name)
  }
  return { ok: true, workspace: updated }
}

function removeWorkspace(id: string): boolean {
  if (!isValidWorkspaceId(id)) {
    log.warn('workspaceManager: removeWorkspace called with invalid id: %s', id)
    return false
  }
  const existing = workspaces.get(id)
  const removed = workspaces.delete(id)
  if (existing?.rootPath) {
    removeAllowedRoot(existing.rootPath)
    // Delete first so rootInUse() doesn't count the workspace we just removed.
    dropProjectLock(existing.rootPath, id)
  }
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
  // Create a new workspace
  ipcMain.handle(
    WORKSPACE_CREATE,
    async (event, options?: { name?: string; rootPath?: string; id?: string }) => {
      const result = await createWorkspace(options?.name, options?.rootPath, options?.id)
      if (!result.ok) return result
      const win = windowFromEvent(event)
      broadcastWorkspaceChange(win?.id)
      return result
    },
  )

  // Update workspace metadata
  ipcMain.handle(
    WORKSPACE_UPDATE,
    async (event, id: string, changes: Partial<Omit<WorkspaceInfo, 'id'>>) => {
      const result = await updateWorkspace(id, changes)
      if (result.ok) {
        const win = windowFromEvent(event)
        broadcastWorkspaceChange(win?.id)
      }
      return result
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
