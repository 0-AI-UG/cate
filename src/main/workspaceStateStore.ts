// =============================================================================
// workspaceStateStore — the four pieces of workspace/session state that used to
// live in the opaque electron-store `config.json`, now each in its own
// hand-editable JSON file under `<userData>/` via ./jsonStateFile:
//
//   recent-projects.json   { projects: string[] }            recency-ordered list
//   sidebar.json           { session: SidebarSession|null }  sidebar order + active
//   remote-workspaces.json { workspaces: RemoteProjectEntry[] } cate-companion:// restore snapshots
//   layouts.json           { layouts: Record<string, unknown> } named saved canvas layouts
//
// On first launch after the migration lands, the legacy config.json is read
// once, any missing file is seeded from it, and config.json is deleted. The
// per-key presence check makes migration idempotent; a corrupt/unparseable
// config.json is quarantined and left in place for support rather than deleted.
// =============================================================================

import { app } from 'electron'
import fs from 'fs'
import path from 'path'
import log from './logger'
import { createJsonStateFile } from './jsonStateFile'
import type { SidebarSession, RemoteProjectEntry } from '../shared/types'

const MAX_RECENT_PROJECTS = 10

// ---------------------------------------------------------------------------
// File shapes + stores. Each top-level value is an object (never a bare array)
// so the file is a stable JSON object the watcher/normalize can rely on.
// ---------------------------------------------------------------------------

interface RecentProjectsFile { projects: string[] }
interface SidebarFile { session: SidebarSession | null }
interface RemoteWorkspacesFile { workspaces: RemoteProjectEntry[] }
interface LayoutsFile { layouts: Record<string, unknown> }

function asObject(parsed: unknown): Record<string, unknown> {
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {}
}

const recentProjectsStore = createJsonStateFile<RecentProjectsFile>({
  filename: 'recent-projects.json',
  defaults: { projects: [] },
  normalize: (parsed, defaults) => {
    const o = asObject(parsed)
    const projects = Array.isArray(o.projects) ? o.projects.filter((p): p is string => typeof p === 'string') : defaults.projects
    return { projects }
  },
})

const sidebarStore = createJsonStateFile<SidebarFile>({
  filename: 'sidebar.json',
  defaults: { session: null },
  normalize: (parsed, defaults) => {
    const o = asObject(parsed)
    const s = o.session
    if (!s || typeof s !== 'object' || Array.isArray(s)) return defaults
    const sess = s as Record<string, unknown>
    const order = Array.isArray(sess.order) ? sess.order.filter((p): p is string => typeof p === 'string') : []
    const selected = typeof sess.selected === 'string' ? sess.selected : ''
    return { session: { order, selected } }
  },
})

const remoteWorkspacesStore = createJsonStateFile<RemoteWorkspacesFile>({
  filename: 'remote-workspaces.json',
  defaults: { workspaces: [] },
  normalize: (parsed, defaults) => {
    const o = asObject(parsed)
    // Keep entry validation light: the renderer's restore path is already
    // defensive about partial/legacy snapshots. We only guarantee the array shape.
    const workspaces = Array.isArray(o.workspaces)
      ? (o.workspaces.filter((w) => w && typeof w === 'object') as RemoteProjectEntry[])
      : defaults.workspaces
    return { workspaces }
  },
})

const layoutsStore = createJsonStateFile<LayoutsFile>({
  filename: 'layouts.json',
  defaults: { layouts: {} },
  normalize: (parsed, defaults) => {
    const o = asObject(parsed)
    const layouts = o.layouts && typeof o.layouts === 'object' && !Array.isArray(o.layouts)
      ? (o.layouts as Record<string, unknown>)
      : defaults.layouts
    return { layouts }
  },
})

// ---------------------------------------------------------------------------
// Typed accessors — preserve the exact payload shapes the existing IPC handlers
// and renderer consumers expect (string[], SidebarSession|null, etc.).
// ---------------------------------------------------------------------------

export function getRecentProjects(): string[] {
  return recentProjectsStore.get().projects
}

export function addRecentProject(projectPath: string): void {
  recentProjectsStore.update((cur) => {
    const filtered = cur.projects.filter((p) => p !== projectPath)
    return { projects: [projectPath, ...filtered].slice(0, MAX_RECENT_PROJECTS) }
  })
}

export function removeRecentProject(projectPath: string): void {
  recentProjectsStore.update((cur) => ({ projects: cur.projects.filter((p) => p !== projectPath) }))
}

export function getSidebarSession(): SidebarSession | null {
  return sidebarStore.get().session
}

export function setSidebarSession(session: SidebarSession): void {
  sidebarStore.set({ session })
}

export function getRemoteProjects(): RemoteProjectEntry[] {
  return remoteWorkspacesStore.get().workspaces
}

export function setRemoteProjects(entries: RemoteProjectEntry[]): void {
  remoteWorkspacesStore.set({ workspaces: Array.isArray(entries) ? entries : [] })
}

export function saveLayout(name: string, layout: unknown): string[] {
  layoutsStore.update((cur) => ({ layouts: { ...cur.layouts, [name]: layout } }))
  return listLayoutNames()
}

export function listLayoutNames(): string[] {
  return Object.keys(layoutsStore.get().layouts)
}

export function loadLayout(name: string): unknown {
  return layoutsStore.get().layouts[name] ?? null
}

export function deleteLayout(name: string): string[] {
  layoutsStore.update((cur) => {
    const layouts = { ...cur.layouts }
    delete layouts[name]
    return { layouts }
  })
  return listLayoutNames()
}

/** Start watching all four files for external edits. `onLayoutsChanged` lets the
 *  caller re-push the native Layouts menu when layouts.json is hand-edited. */
export function startWatchingWorkspaceState(onLayoutsChanged: (names: string[]) => void): void {
  recentProjectsStore.startWatching(() => { /* read on demand */ })
  sidebarStore.startWatching(() => { /* read on demand */ })
  remoteWorkspacesStore.startWatching(() => { /* read on demand */ })
  layoutsStore.startWatching((next) => onLayoutsChanged(Object.keys(next.layouts)))
}

/** Flush any pending debounced writes synchronously (call on app quit). */
export function flushWorkspaceStateSync(): void {
  recentProjectsStore.flushPendingWritesSync()
  sidebarStore.flushPendingWritesSync()
  remoteWorkspacesStore.flushPendingWritesSync()
  layoutsStore.flushPendingWritesSync()
}

// ---------------------------------------------------------------------------
// One-time migration from the legacy electron-store config.json.
// ---------------------------------------------------------------------------

function legacyConfigPath(): string {
  return path.join(app.getPath('userData'), 'config.json')
}

/**
 * Migrate the four workspace-state keys out of the legacy config.json into their
 * dedicated files, then delete config.json. Idempotent (per-file presence check)
 * and corrupt-safe (an unparseable config.json is quarantined and left in place).
 * Must run AFTER settingsFile.loadSettingsSync(), which also reads config.json
 * (for settings keys) on its own first run.
 */
export function migrateLegacyConfig(): void {
  const cfgPath = legacyConfigPath()
  let raw: string
  try {
    if (!fs.existsSync(cfgPath)) return
    raw = fs.readFileSync(cfgPath, 'utf-8')
  } catch (err) {
    log.warn('[workspaceStateStore] reading legacy config.json failed: %O', err)
    return
  }

  let parsed: Record<string, unknown>
  try {
    const p = JSON.parse(raw)
    if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Error('not an object')
    parsed = p as Record<string, unknown>
  } catch {
    // Corrupt: preserve for support and bail without deleting.
    try {
      fs.copyFileSync(cfgPath, `${cfgPath}.corrupt-${Date.now()}`)
    } catch { /* best effort */ }
    log.error('[workspaceStateStore] legacy config.json is corrupt; skipping migration (preserved a backup)')
    return
  }

  // Seed only files that don't exist yet, so re-running never clobbers state the
  // user has already changed under the new files.
  const userData = app.getPath('userData')
  const exists = (name: string): boolean => fs.existsSync(path.join(userData, name))

  if (!exists('recent-projects.json') && Array.isArray(parsed.recentProjects)) {
    recentProjectsStore.set({
      projects: (parsed.recentProjects as unknown[]).filter((p): p is string => typeof p === 'string'),
    })
  }
  if (!exists('sidebar.json') && parsed.sidebarSession && typeof parsed.sidebarSession === 'object') {
    setSidebarSession(parsed.sidebarSession as SidebarSession)
  }
  if (!exists('remote-workspaces.json') && Array.isArray(parsed.remoteProjects)) {
    setRemoteProjects(parsed.remoteProjects as RemoteProjectEntry[])
  }
  if (!exists('layouts.json') && parsed.layouts && typeof parsed.layouts === 'object' && !Array.isArray(parsed.layouts)) {
    layoutsStore.set({ layouts: parsed.layouts as Record<string, unknown> })
  }

  // Flush the seeded files to disk synchronously, then remove config.json so the
  // migration never runs again. settings.json was already seeded earlier in
  // startup (settingsFile), so deleting config.json here is safe.
  flushWorkspaceStateSync()
  try {
    fs.unlinkSync(cfgPath)
    log.info('[workspaceStateStore] migrated config.json to discrete state files and removed it')
  } catch (err) {
    log.warn('[workspaceStateStore] removing legacy config.json failed: %O', err)
  }
}
