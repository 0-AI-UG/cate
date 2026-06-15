// =============================================================================
// App Store — shared helpers (free functions, sync queue, panel placement).
// Imported by the slices and the index barrel; imports only leaf modules so the
// appStore graph stays acyclic at load.
// =============================================================================

import log from '../../lib/logger'
import type {
  WorkspaceState,
  WorkspaceInfo,
  WorkspaceMutationResult,
  PanelState,
  PanelType,
  Point,
  DockStateSnapshot,
  RuntimeConnection,
} from '../../../shared/types'
import { ACCENT_COLORS } from '../../../shared/colors'
import { BASE_DARK, BASE_LIGHT } from '../../../shared/themes'
import { getActiveTheme } from '../../lib/themeManager'
import { generateId } from '../canvas/helpers'
import { getOrCreateWorkspaceDockStore } from '../../lib/workspace/dockRegistry'
import { createDefaultDockState } from '../dockStore'
import {
  ensureCanvasOpsForPanel,
  getActiveCanvasOps,
  getWorkspaceCanvasOps,
} from '../../lib/workspace/canvasAccess'
import { useWindowPanelStore } from '../windowPanelStore'
import { useSettingsStore } from '../settingsStore'
import type { AppSet, AppGet, PanelPlacement } from './types'

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/**
 * Load a freshly-opened workspace's saved `.cate/` layout into its stores.
 * Dynamically imported to avoid a static cycle (session.ts imports appStore).
 * hydrateWorkspaceFromDiskIfEmpty is internally guarded (rootPath + no live
 * content + not deferred), so this is a safe, idempotent no-op otherwise. For a
 * remote workspace the caller must ensure the runtime is connected first.
 */
export async function hydrateWorkspaceFromDisk(wsId: string): Promise<void> {
  try {
    const { hydrateWorkspaceFromDiskIfEmpty } = await import('../../lib/workspace/session')
    await hydrateWorkspaceFromDiskIfEmpty(wsId)
  } catch (err) {
    log.warn('[workspace] hydrate-on-open failed for %s:', wsId, err)
  }
}

/** Workspace accent colors — re-exported from the shared accent palette. */
export const WORKSPACE_COLORS = ACCENT_COLORS

export function createDefaultWorkspace(
  name?: string,
  rootPath?: string,
  id?: string,
  connection?: RuntimeConnection,
): WorkspaceState {
  return {
    id: id ?? generateId(),
    name: name ?? 'Workspace',
    color: '',
    rootPath: rootPath ?? '',
    // Carry remote reconnect info through restore so ensureWorkspaceRuntime
    // can reconnect the runtime before any fs/git/terminal op (Finding 2).
    ...(connection && connection.kind !== 'local' ? { connection } : {}),
    rootPathError: null,
    isRootPathPending: false,
    panels: {},
  }
}

// -----------------------------------------------------------------------------
// Main-process sync helpers (fire-and-forget — local state is optimistic)
// -----------------------------------------------------------------------------

// Serialize workspace mutations so main-process state can't diverge from
// renderer state when multiple updates fire in quick succession (the previous
// fire-and-forget approach allowed them to land out of order).
let workspaceSyncQueue: Promise<unknown> = Promise.resolve()
function enqueueWorkspaceSync<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
  workspaceSyncQueue = workspaceSyncQueue
    .then(fn, fn)
    .catch((err) => log.warn(`[workspace-sync] ${label} failed:`, err))
  const resultPromise = workspaceSyncQueue as Promise<T | undefined>
  return resultPromise
}

// Callers that need to invoke main-process IPC depending on a workspace's
// rootPath (e.g. terminal:create with cwd=rootPath) must await this first.
// Otherwise the IPC can race a pending workspace:create / workspace:update and
// fail validation with "outside allowed directories" because the new root
// hasn't been registered in allowedRoots yet.
export function awaitWorkspaceSync(): Promise<void> {
  return workspaceSyncQueue.then(() => undefined, () => undefined)
}

export function applyWorkspaceInfo(ws: WorkspaceState, info: WorkspaceInfo): WorkspaceState {
  return {
    ...ws,
    id: info.id,
    name: info.name,
    color: info.color,
    rootPath: info.rootPath,
    connection: info.connection ?? ws.connection,
    rootPathError: null,
    isRootPathPending: false,
  }
}

export function syncCreateToMain(ws: WorkspaceState): Promise<WorkspaceMutationResult | undefined> {
  return enqueueWorkspaceSync('Create', () =>
    window.electronAPI.workspaceCreate({
      name: ws.name,
      rootPath: ws.rootPath,
      id: ws.id,
      // Pass remote reconnect info so WorkspaceInfo.connection survives on the
      // main side (Finding 2) — main skips local realpath/lock for a locator.
      ...(ws.connection && ws.connection.kind !== 'local' ? { connection: ws.connection } : {}),
    }),
  )
}

export function syncUpdateToMain(id: string, changes: Partial<Omit<WorkspaceInfo, 'id'>>): Promise<WorkspaceMutationResult | undefined> {
  return enqueueWorkspaceSync('Update', () => window.electronAPI.workspaceUpdate(id, changes))
}

export function syncRemoveFromMain(id: string): void {
  enqueueWorkspaceSync('Remove', () => window.electronAPI.workspaceRemove(id))
}

// -----------------------------------------------------------------------------
// Worktree colors — a multi-color palette derived from the ACTIVE theme rather
// than a fixed hardcoded set, so the swatches look native to whatever theme is
// loaded. Source is the theme's terminal ANSI palette (a rich, vivid, multi-hue
// set every theme defines, and — unlike the git/panel app colors — not tied to
// other UI meaning).
//
// The theme accent (--focus-blue) is excluded DYNAMICALLY: we drop whichever
// ANSI hue is closest to it, so a worktree color is never confused with focus/
// selection chrome. The accent isn't always blue — in a red-accented theme it's
// the red entry that drops, in a green-accented one the green entry, etc.
//
// Picked colors are resolved to concrete #rrggbb and stored on the worktree, so
// they keep working in the canvas territory renderer (which parses hex) and a
// worktree keeps its color across later theme switches.
// -----------------------------------------------------------------------------

/** Vivid ANSI hue slots, ordered so the first picks are calm, distinct hues.
 *  The PRIMARY worktree takes slot 0 (pickWorktreeColor on an empty list), so it
 *  must not be an alarming red — green reads as "main/ok". Red is pushed last so
 *  it only appears once a workspace has many worktrees. Blacks/whites/grays are
 *  omitted. Blue is kept here on purpose — only the hue closest to the *actual*
 *  accent is dropped below, so in a non-blue-accent theme blue stays available
 *  (and in the usual blue-accent themes it drops). */
const WORKTREE_ANSI_KEYS = [
  'green', 'cyan', 'magenta', 'yellow',
  'brightGreen', 'brightCyan', 'brightMagenta', 'brightYellow',
  'blue', 'brightBlue',
  'red', 'brightRed',
] as const

/** Squared-RGB distance below which a hue is treated as "the accent" (dropped). */
const ACCENT_EXCLUDE_DIST2 = 10000
/** Squared-RGB distance below which two hues are treated as duplicates. */
const DUP_EXCLUDE_DIST2 = 800

/** Safety net if a theme somehow yields too few usable hues (no blue). */
const FALLBACK_WORKTREE_COLORS = ['#10b981', '#f59e0b', '#ec4899', '#8b5cf6', '#ef4444']

/** Parse #rgb / #rrggbb / #rrggbbaa or rgb()/rgba() into [r,g,b], else null. */
function parseRgb(color: string): [number, number, number] | null {
  const s = color.trim()
  const hex = /^#?([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(s)
  if (hex) {
    let h = hex[1]
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
    const n = parseInt(h.slice(0, 6), 16)
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  }
  const rgb = /^rgba?\(\s*(\d+)\D+(\d+)\D+(\d+)/i.exec(s)
  if (rgb) return [Number(rgb[1]) & 255, Number(rgb[2]) & 255, Number(rgb[3]) & 255]
  return null
}

function toHex([r, g, b]: [number, number, number]): string {
  return '#' + [r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')
}

function dist2(a: [number, number, number], b: [number, number, number]): number {
  const dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2]
  return dr * dr + dg * dg + db * db
}

/** The current theme's worktree color palette: vivid ANSI hues, accent-hue and
 *  near-duplicates removed, resolved to concrete #rrggbb. Reflects the active
 *  theme each time it's called (cheap — call at pick / when rendering swatches). */
export function getWorktreeColorPalette(): string[] {
  const theme = getActiveTheme()
  const base = theme.type === 'light' ? BASE_LIGHT : BASE_DARK
  const accent = parseRgb(theme.app['focus-blue'] ?? base['focus-blue'])

  const out: string[] = []
  const chosen: [number, number, number][] = []
  for (const key of WORKTREE_ANSI_KEYS) {
    const rgb = parseRgb(theme.terminal[key])
    if (!rgb) continue
    if (accent && dist2(rgb, accent) < ACCENT_EXCLUDE_DIST2) continue
    if (chosen.some((c) => dist2(c, rgb) < DUP_EXCLUDE_DIST2)) continue
    chosen.push(rgb)
    out.push(toHex(rgb))
  }
  return out.length >= 3 ? out : FALLBACK_WORKTREE_COLORS
}

export function pickWorktreeColor(existing: { color: string }[]): string {
  const palette = getWorktreeColorPalette()
  const used = new Set(existing.map((w) => w.color))
  for (const c of palette) if (!used.has(c)) return c
  // Wrap around if more worktrees than palette entries.
  return palette[existing.length % palette.length]
}

/** A fully-reset dock layout: all side zones hidden, an empty visible center.
 *  Used whenever we need to clear a workspace's dock so panels from a previous
 *  workspace can't bleed through (workspace switch, removal, closeAllPanels). */
export function createCleanDockSnapshot(): DockStateSnapshot {
  return {
    zones: createDefaultDockState(),
    locations: {},
  }
}

// -----------------------------------------------------------------------------
// Panel placement / mutation helpers (take set/get; shared across slices)
// -----------------------------------------------------------------------------

/** Place a panel into its workspace's dock or canvas. Routes by the workspace's
 *  own stores so it works for the active workspace AND for a background restore
 *  into an inactive one — never touching another workspace's layout. */
function placePanel(
  workspaceId: string,
  panelId: string,
  panelType: PanelType,
  placement: PanelPlacement | undefined,
  position: Point | undefined,
  isActiveWorkspace: boolean,
  onGhostCancel?: (panelId: string) => void,
): void {
  // No-op: caller is placing the panel itself into a private DockStore.
  if (placement?.target === 'none') return
  const dockStore = getOrCreateWorkspaceDockStore(workspaceId)
  // Canvas panels go to the center dock zone, not onto a canvas as a node
  if (panelType === 'canvas') {
    dockStore.getState().dockPanel(panelId, 'center')
    return
  }
  if (placement?.target === 'dock') {
    // stackId → drop as a tab in that exact stack (the focused split pane);
    // otherwise zone-level. dockPanel falls back to the zone if the stack is gone.
    dockStore.getState().dockPanel(
      panelId,
      placement.zone,
      placement.stackId ? { type: 'tab', stackId: placement.stackId } : undefined,
    )
    return
  }
  // Default: place on a canvas (target === 'canvas'/'auto'/undefined).
  // Prefer the explicit originating canvas when the caller pinned one (an
  // interactive create from a specific canvas's toolbar/menu/drop), so the node
  // lands on the canvas the user aimed at — not just the primary one. An
  // unpinned create on the ACTIVE workspace lands on the canvas the user is
  // looking at (the active one) — the workspace's primary canvas is the wrong
  // (hidden) target whenever a secondary canvas tab is active. Background
  // restores into an inactive workspace keep the primary-canvas routing.
  const pinnedCanvasId = placement?.target === 'canvas' ? placement.canvasPanelId : undefined
  const ops = pinnedCanvasId
    ? ensureCanvasOpsForPanel(pinnedCanvasId)
    : (isActiveWorkspace ? getActiveCanvasOps() : null) ?? getWorkspaceCanvasOps(workspaceId)
  if (!ops) {
    // No canvas to place onto — e.g. a detached dock window (center zone only)
    // where nothing was focused, so placementForActivePanel couldn't tab into a
    // stack. Fall back to the center dock zone so the panel still lands instead
    // of becoming a ghost. (The main window always has a center canvas, so this
    // only engages for canvas-less windows.)
    dockStore.getState().dockPanel(panelId, 'center')
    return
  }
  const canvasPosition = placement?.target === 'canvas' ? placement.position ?? position : position
  const canvasSize = placement?.target === 'canvas' ? placement.size : undefined
  // Ambiguous create (no explicit position) on the active workspace: when the
  // recommendation picker is enabled, show ghost candidates and let the user
  // choose where the node lands (deferred until commit; onGhostCancel rolls the
  // panel back). When the setting is off — or for a background restore — fall
  // through and auto-place in the best spot. Explicit-position paths (drag-drop,
  // session restore, right-click "new here") always skip the picker.
  if (isActiveWorkspace && canvasPosition == null && onGhostCancel && useSettingsStore.getState().placementPicker) {
    const shown = ops.beginPlacement(panelId, panelType, onGhostCancel, canvasSize)
    if (shown) return
  }
  ops.addNodeAndFocus(panelId, panelType, canvasPosition, canvasSize)
}

/** Next "<base> N" title for a panel type within a workspace, unique across ALL
 *  windows — it scans this window's panels AND the cross-window union
 *  (windowPanelStore), so detaching a "Terminal 2" into another window still
 *  makes the next one "Terminal 3" rather than colliding. `base` is a code
 *  literal ('Terminal'/'Agent'), so it's safe to interpolate into the regex. */
export function nextNumberedTitle(get: AppGet, workspaceId: string, type: PanelType, base: string): string {
  const re = new RegExp(`^${base}\\s+(\\d+)$`)
  let maxN = 0
  const consider = (title: string): void => {
    const m = re.exec(title)
    if (m) {
      const n = parseInt(m[1], 10)
      if (n > maxN) maxN = n
    }
  }
  const ws = get().workspaces.find((w) => w.id === workspaceId)
  if (ws) for (const p of Object.values(ws.panels)) if (p.type === type) consider(p.title)
  for (const p of useWindowPanelStore.getState().panels) {
    if (p.workspaceId === workspaceId && p.type === type) consider(p.title)
  }
  return `${base} ${maxN + 1}`
}

/** Add a freshly-built panel to a workspace, then route it to its canvas/dock
 *  location. On placement failure the panel is rolled back out of the workspace
 *  so no orphaned entry lingers. Shared by every create* action. */
export function addAndPlacePanel(
  set: AppSet,
  get: AppGet,
  workspaceId: string,
  panel: PanelState,
  placement: PanelPlacement | undefined,
  position: Point | undefined,
): string {
  set((state) => ({
    workspaces: state.workspaces.map((ws) =>
      ws.id === workspaceId
        ? { ...ws, panels: { ...ws.panels, [panel.id]: panel } }
        : ws,
    ),
  }))
  // Roll the panel record back out of the workspace — used both on a placement
  // error and when an interactive ghost placement is cancelled (no orphan left).
  const discardPanel = () => {
    set((state) => ({
      workspaces: state.workspaces.map((ws) =>
        ws.id === workspaceId
          ? { ...ws, panels: Object.fromEntries(
              Object.entries(ws.panels).filter(([id]) => id !== panel.id)
            )}
          : ws,
      ),
    }))
  }
  try {
    placePanel(workspaceId, panel.id, panel.type, placement, position, workspaceId === get().selectedWorkspaceId, discardPanel)
  } catch (error) {
    discardPanel()
    log.error(`Failed to place ${panel.type} panel:`, error)
    return null as unknown as string
  }
  return panel.id
}

/** Apply an update to a single panel within a workspace. No-ops if the
 *  workspace or panel is missing, or if `update` returns the same panel
 *  reference (lets callers bail out without mutating). Shared by every
 *  panel-field setter. */
export function setPanelField(
  set: AppSet,
  workspaceId: string,
  panelId: string,
  update: (panel: PanelState) => PanelState,
): void {
  set((state) => ({
    workspaces: state.workspaces.map((ws) => {
      if (ws.id !== workspaceId) return ws
      const panel = ws.panels[panelId]
      if (!panel) return ws
      const next = update(panel)
      if (next === panel) return ws
      return { ...ws, panels: { ...ws.panels, [panelId]: next } }
    }),
  }))
}
