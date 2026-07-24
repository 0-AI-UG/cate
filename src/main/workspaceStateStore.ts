// =============================================================================
// workspaceStateStore — the four pieces of workspace/session state, each in its
// own hand-editable JSON file under `<userData>/` via ./jsonStateFile:
//
//   recent-projects.json   { projects: string[] }            recency-ordered list
//   sidebar.json           { session: SidebarSession|null }  sidebar order + active
//   remote-workspaces.json { workspaces: RemoteProjectEntry[] } cate-runtime:// restore snapshots
//   layouts.json           { layouts: Record<string, unknown> } named saved canvas layouts
//   trusted-projects.json  { projects: string[] }            locators trusted to auto-restore
//
// trusted-projects.json lives HERE, in userData, and never in the project — a
// repo must not be able to vouch for itself (GHSA-8769-jp52-985f).
// =============================================================================

import { createJsonStateFile } from './jsonStateFile'
import { isPlainObject } from './jsonUtils'
import type { SidebarSession, RemoteProjectEntry } from '../shared/types'
import { isRuntimeLocator } from '../shared/runtimeLocator'
import { isRemoteRuntimeConnection } from '../shared/runtimeConnection'

const MAX_RECENT_PROJECTS = 10

function isRemoteProjectEntry(value: unknown): value is RemoteProjectEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const entry = value as Partial<RemoteProjectEntry>
  return typeof entry.locator === 'string'
    && isRuntimeLocator(entry.locator)
    && isRemoteRuntimeConnection(entry.connection)
    && !!entry.snapshot
    && typeof entry.snapshot === 'object'
}

// ---------------------------------------------------------------------------
// File shapes + stores. Each top-level value is an object (never a bare array)
// so the file is a stable JSON object the watcher/normalize can rely on.
// ---------------------------------------------------------------------------

interface RecentProjectsFile { projects: string[] }
interface SidebarFile { session: SidebarSession | null }
interface RemoteWorkspacesFile { workspaces: RemoteProjectEntry[] }
interface LayoutsFile { layouts: Record<string, unknown> }
interface TrustedProjectsFile { projects: string[] }

function asObject(parsed: unknown): Record<string, unknown> {
  return isPlainObject(parsed) ? parsed : {}
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
    const workspaces = Array.isArray(o.workspaces)
      ? o.workspaces.filter(isRemoteProjectEntry)
      : defaults.workspaces
    return { workspaces }
  },
})

const layoutsStore = createJsonStateFile<LayoutsFile>({
  filename: 'layouts.json',
  defaults: { layouts: {} },
  normalize: (parsed, defaults) => {
    const o = asObject(parsed)
    const layouts = isPlainObject(o.layouts) ? o.layouts : defaults.layouts
    return { layouts }
  },
})

// Unbounded on purpose (unlike recent-projects): forgetting a trust decision
// because the list grew would silently re-prompt on a project the user already
// vouched for, training them to click through the banner.
const trustedProjectsStore = createJsonStateFile<TrustedProjectsFile>({
  filename: 'trusted-projects.json',
  defaults: { projects: [] },
  normalize: (parsed, defaults) => {
    const o = asObject(parsed)
    const projects = Array.isArray(o.projects) ? o.projects.filter((p): p is string => typeof p === 'string') : defaults.projects
    return { projects }
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

/** Locators (local paths or cate-runtime:// URLs) the user has explicitly
 *  trusted to auto-restore process-bearing panels and load project MCP config. */
export function getTrustedProjects(): string[] {
  return trustedProjectsStore.get().projects
}

export function isProjectTrusted(locator: string): boolean {
  return !!locator && trustedProjectsStore.get().projects.includes(locator)
}

/** Record (or revoke) an explicit user trust decision for a project locator. */
export function setProjectTrusted(locator: string, trusted: boolean): void {
  if (!locator) return
  trustedProjectsStore.update((cur) => {
    const without = cur.projects.filter((p) => p !== locator)
    return { projects: trusted ? [...without, locator] : without }
  })
}

/** Start watching all five files for external edits. `onLayoutsChanged` lets the
 *  caller re-push the native Layouts menu when layouts.json is hand-edited. */
export function startWatchingWorkspaceState(onLayoutsChanged: (names: string[]) => void): void {
  recentProjectsStore.startWatching(() => { /* read on demand */ })
  sidebarStore.startWatching(() => { /* read on demand */ })
  remoteWorkspacesStore.startWatching(() => { /* read on demand */ })
  layoutsStore.startWatching((next) => onLayoutsChanged(Object.keys(next.layouts)))
  trustedProjectsStore.startWatching(() => { /* read on demand */ })
}

/** Flush any pending debounced writes synchronously (call on app quit). */
export function flushWorkspaceStateSync(): void {
  recentProjectsStore.flushPendingWritesSync()
  sidebarStore.flushPendingWritesSync()
  remoteWorkspacesStore.flushPendingWritesSync()
  layoutsStore.flushPendingWritesSync()
  trustedProjectsStore.flushPendingWritesSync()
}
