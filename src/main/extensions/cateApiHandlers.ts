// =============================================================================
// Extension IPC handlers — both halves of the extension system's main surface:
//
//   1. Extension management (renderer <-> main): list/enable/disable/sideload/
//      proxy-url, registered against the EXTENSION_* channels.
//   2. The cateHost reverse API (webview guest <-> main): CATE_HOST_INVOKE and
//      the subscribe/unsubscribe handlers, plus the forward-reply handler that
//      completes a request forwarded to the owning renderer.
//
// Dispatch policy for cate.* methods (see docs/extensions.md):
//   - Handled in main: version, workspace.get, theme.get, ui.notify, storage.*
//   - Forwarded to the owning renderer (they touch renderer state):
//     editor.openFile, canvas.createPanel, panel.setTitle, panel.list,
//     panel.focus
//   - cate.browser.*: forwarded to the OWNER window of the target browser panel
//     (args.panelId), or the active main window when unaddressed.
//   - cate.terminal.*: same owner-window routing for terminal panels;
//     first-party (CLI) callers only, with read and type/press each gated by
//     their Settings → CLI toggle.
//   - Anything else: { error: 'unsupported', method }
//
// Every invoke validates the extension is enabled before serving, EXCEPT
// first-party (terminal/agent) callers, which are trusted and bypass that gate.
// =============================================================================

import { ipcMain, app, dialog, type WebContents } from 'electron'
import { randomUUID } from 'crypto'
import path from 'path'
import log from '../logger'
import {
  cliPermissionCellByKey,
  cliPermissionDenied,
  cliPermissionForMethod,
  type CliPermissionKey,
} from '../../shared/cliPermissions'
import {
  EXTENSION_LIST,
  EXTENSION_ENABLE,
  EXTENSION_DISABLE,
  EXTENSION_ADD_SIDELOAD,
  EXTENSION_REMOVE_SIDELOAD,
  EXTENSION_CATALOG_REFRESH,
  EXTENSION_INSTALL,
  EXTENSION_UNINSTALL,
  EXTENSION_REINSTALL,
  EXTENSION_UPDATE,
  EXTENSION_ADD_CATALOG_SOURCE,
  EXTENSION_REMOVE_CATALOG_SOURCE,
  EXTENSION_CATALOG_SOURCES,
  EXTENSION_PROXY_URL,
  EXTENSION_PANEL_CLOSED,
  EXTENSION_SERVER_RESTART,
  CATE_HOST_INVOKE,
  CATE_HOST_SUBSCRIBE,
  CATE_HOST_UNSUBSCRIBE,
  CATE_HOST_EVENT,
  CATE_HOST_FORWARD,
  CATE_HOST_FORWARD_REPLY,
} from '../../shared/ipc-channels'
import { extensionManager } from './ExtensionManager'
import { getCachedCatalog } from './catalog'
import { getProxyUrlFor, identityForGuestUrl } from './proxyServer'
import { extensionServerManager } from './ExtensionServerManager'
import { agentManager } from '../../agent/main/agentManager'
import { getExtensionStorage } from './storage'
import { getWorkspaceInfo } from '../workspaceManager'
import { getActiveMainWindow, getWindow } from '../windowRegistry'
import { getWindowPanels, removeWindowPanel, revealWindowPanel, upsertWindowPanel } from '../windowPanels'
import { parseLocator, LOCAL_RUNTIME_ID } from '../runtime/locator'
import { getAllSettings, getSetting } from '../settingsFile'
import { resolveActiveTheme } from '../themeBootCache'
import { showOsNotification } from '../ipc/notifications'
import type { PanelType } from '../../shared/types'

/** Bumped when the cateHost API surface changes incompatibly. Guests use
 *  `cate.version` for feature detection. v4 adds generation-scoped browser
 *  refs, native fill/click actions, conditional waits, and action snapshots.
 *  v3 removals: browser.list and
 *  editor.active (cate.panel.list is the single enumeration surface — browser
 *  panels carry `url`, the focused entry answers "what is the user looking
 *  at"); browser.back/forward/current (navigate by URL; `wait` reads the
 *  settled url/title instantly when idle); agent.run (compose open -> send ->
 *  dispose). */
const CATE_API_VERSION = 4

const FORWARD_TIMEOUT_MS = 10_000

/** Stable errors for CLI permission cells (Settings → CLI) that are off. Each
 *  tells the caller how to get the feature enabled, not just that it is denied.
 *  Derived from the matrix so the copy has one home. */
const deniedFor = (key: CliPermissionKey): string => cliPermissionDenied(cliPermissionCellByKey(key))
export const TERMINAL_INPUT_DISABLED = deniedFor('cliTerminalInputEnabled')
export const TERMINAL_READ_DISABLED = deniedFor('cliTerminalReadEnabled')
export const BROWSER_READ_DISABLED = deniedFor('cliBrowserReadEnabled')
export const BROWSER_CONTROL_DISABLED = deniedFor('cliBrowserControlEnabled')

interface InvokePayload {
  extensionId: string
  workspaceId: string
  panelId: string
  method: string
  args: unknown
}

type InvokeResult = unknown | { error: string; method?: string }

/** Scope a cate.* invoke runs under, decoupled from any IPC event. `forward`
 *  delivers a state-mutating method to a renderer that owns the relevant state
 *  (the guest's sender for IPC; a best-effort workspace window for CATE_API). */
export interface InvokeScope {
  extensionId: string
  workspaceId: string
  panelId: string | undefined
  forward: (payload: InvokePayload) => Promise<InvokeResult>
  /** Who is calling. First-party (terminal/agent via the CLI/reverse endpoint)
   *  callers are trusted: they skip the extension-enabled gate and the browser
   *  consent prompt. Undefined is treated as 'extension'. */
  caller?: 'extension' | 'first-party'
  /** Scopes the caller was granted. For first-party callers this is supplied by
   *  the env-manager instead of a manifest; when absent the extension manifest's
   *  `cateApi` is used. */
  grantedScopes?: string[]
}

// ---------------------------------------------------------------------------
// Guest subscription registry — maps a subscribing webContents to its
// (extensionId, panelId) so storage.change events reach only that guest.
// ---------------------------------------------------------------------------

interface Subscription {
  wc: WebContents
  extensionId: string
  workspaceId: string
  panelId: string
  topic: string
  dispose: () => void
}

const subscriptions = new Set<Subscription>()

function disposeSubscriptionsFor(wc: WebContents): void {
  for (const sub of [...subscriptions]) {
    if (sub.wc === wc) {
      try { sub.dispose() } catch { /* noop */ }
      subscriptions.delete(sub)
    }
  }
}

// ---------------------------------------------------------------------------
// Forward request/response — completes a CATE_HOST_FORWARD sent to a renderer.
// ---------------------------------------------------------------------------

const pendingForwards = new Map<
  string,
  { resolve: (r: InvokeResult) => void; timer: ReturnType<typeof setTimeout> }
>()

export function forwardToOwner(
  owner: WebContents,
  payload: InvokePayload,
): Promise<InvokeResult> {
  return new Promise<InvokeResult>((resolve) => {
    const requestId = randomUUID()
    const timer = setTimeout(() => {
      pendingForwards.delete(requestId)
      resolve({ error: 'timeout', method: payload.method })
    }, FORWARD_TIMEOUT_MS)
    pendingForwards.set(requestId, { resolve, timer })
    try {
      owner.send(CATE_HOST_FORWARD, {
        requestId,
        workspaceId: payload.workspaceId,
        panelId: payload.panelId,
        extensionId: payload.extensionId,
        method: payload.method,
        args: payload.args,
      })
    } catch (err) {
      clearTimeout(timer)
      pendingForwards.delete(requestId)
      resolve({ error: 'no-owner', method: payload.method })
      log.warn('[extensions] forward send failed: %O', err)
    }
  })
}

/**
 * Forward a state-mutating cate.* method to the active main window's renderer
 * (where useCateHostActionResponder is mounted). Shared by both entry points
 * that have no direct owner sender: the CATE_HOST_INVOKE guest path (the guest's
 * WebContents doesn't host the responder) and the CATE_API reverse path (the
 * extension server has no sender at all). Best-effort — there's no authoritative
 * workspace→window map for main windows.
 */
export function forwardToActiveWindow(payload: InvokePayload): Promise<InvokeResult> {
  const win = getActiveMainWindow()
  if (!win || win.isDestroyed()) {
    return Promise.resolve({ error: 'no-host-window', method: payload.method })
  }
  return forwardToOwner(win.webContents, payload)
}

/**
 * Resolve the webContents that should receive a cate.browser.* / cate.terminal.*
 * method: the window that OWNS the addressed panel (of the required type), or
 * the active main window when the caller doesn't address a specific panel.
 * Unlike the state-mutating forwards above, these methods must reach the exact
 * window hosting that panel's webview/xterm, not just any active window.
 */
function resolvePanelTargetWindow(
  panelId: string | undefined,
  type: 'browser' | 'terminal',
): { wc: WebContents; ownerWindowId: number } | { error: string } {
  if (panelId) {
    const info = getWindowPanels().find((p) => p.panelId === panelId)
    if (!info || info.type !== type) return { error: `no-such-${type}` }
    const win = getWindow(info.ownerWindowId)
    if (!win || win.isDestroyed()) return { error: 'no-host-window' }
    return { wc: win.webContents, ownerWindowId: info.ownerWindowId }
  }
  const win = getActiveMainWindow()
  if (!win || win.isDestroyed()) return { error: 'no-host-window' }
  return { wc: win.webContents, ownerWindowId: win.id }
}

// ---------------------------------------------------------------------------
// Method dispatch
// ---------------------------------------------------------------------------

const FORWARDED_METHODS = new Set([
  'editor.openFile',
  'canvas.createPanel',
])

function unsupported(method: string): InvokeResult {
  return { error: 'unsupported', method }
}

// ---------------------------------------------------------------------------
// Manifest scope enforcement — every cate.* method (except always-allowed
// feature-detection / panel-identity ones) requires a declared `cateApi` scope.
// Scopes are namespaced (e.g. `editor.write`); declaring the bare namespace
// (`editor`) satisfies any method under it. See docs/extensions.md.
// ---------------------------------------------------------------------------

/** Maps a cate.* method to the scope it requires, or null when always allowed
 *  (version / panel identity). Returns undefined for unknown methods. */
export function requiredScopeFor(method: string): string | null | undefined {
  switch (method) {
    case 'cate.version':
      return null
    case 'cate.workspace.get':
      return 'workspace.read'
    case 'cate.theme.get':
      return 'theme'
    case 'cate.ui.notify':
      return 'ui'
    case 'cate.editor.openFile':
      return 'editor.write'
    // Unlike the self-identity panel.* methods below, these read or steer OTHER
    // panels — they need an explicit `panel` grant.
    case 'cate.panel.list':
    case 'cate.panel.focus':
    case 'cate.panel.close':
      return 'panel'
    default:
      // A panel controlling its own identity (id / title / badge) needs no scope.
      if (method.startsWith('cate.panel.')) return null
      if (method.startsWith('cate.storage.')) return 'storage'
      if (method.startsWith('cate.canvas.')) return 'canvas'
      if (method.startsWith('cate.agent.')) return 'agent'
      if (method.startsWith('cate.editor.')) return 'editor.read'
      if (method.startsWith('cate.browser.')) return 'browser'
      if (method.startsWith('cate.terminal.')) return 'terminal'
      return undefined
  }
}

/** True when the manifest's declared scopes grant `required`. A declared scope
 *  matches the required one exactly OR is its bare namespace prefix (e.g. the
 *  scope `editor` grants `editor.write`). */
function scopeGranted(declared: string[] | undefined, required: string): boolean {
  if (!declared || declared.length === 0) return false
  const namespace = required.includes('.') ? required.slice(0, required.indexOf('.')) : required
  return declared.some((s) => s === required || s === namespace)
}

// Extensions granted a powerful capability this app session, keyed by
// capability. In-memory + host-owned so an extension can't grant itself;
// re-asked on next launch (a deliberate re-confirm rather than a persisted
// grant). First-party callers are trusted and never reach the prompt.
const consentGranted = new Map<ConsentCapability, Set<string>>()

type ConsentCapability = 'agent' | 'browser'

/** Per-capability prompt copy — the only thing that differs between capabilities.
 *  `message` takes the extension's display name. */
const CONSENT_PROMPTS: Record<ConsentCapability, { title: string; message: (name: string) => string; detail: string }> = {
  agent: {
    title: 'Run agent?',
    message: (name) => `Allow “${name}” to run the agent?`,
    detail:
      'This extension wants to run agent tasks on your behalf using your configured model and credentials. ' +
      'The agent can read and modify files in this workspace. You can watch and stop a run in the Agent panel.',
  },
  browser: {
    title: 'Control the browser?',
    message: (name) => `Allow “${name}” to control the browser?`,
    detail:
      'This extension wants to control the browser panel (navigate, go back/forward, run actions), ' +
      'which may act on your logged-in sessions. You can revoke this by disabling the extension.',
  },
}

/** The active main window the agent run is attached to, or undefined if none. */
function requireHostWindow(): ReturnType<typeof getActiveMainWindow> {
  const win = getActiveMainWindow()
  return win && !win.isDestroyed() ? win : undefined
}

/** Map an agentManager rejection to an InvokeResult error. Known lifecycle codes
 *  pass through as-is; anything else is the agent's own failure reason (e.g. an
 *  unsupported-model or auth message from pi), surfaced so the extension can show
 *  it instead of a useless generic code. */
function agentError(err: unknown, method: string): InvokeResult {
  const message = err instanceof Error ? err.message : String(err)
  if (message === 'agent-busy') return { error: 'agent-busy', method }
  if (message === 'no-session') return { error: 'no-session', method }
  return { error: message || 'agent-failed', method }
}

/**
 * Bound a guest-supplied `cate.agent.open({ resume })` handle to the caller's own
 * workspace so an extension can't resume/read another workspace's (or an arbitrary
 * host file's) pi conversation.
 *
 * The `resume` handle IS pi's session-jsonl path — the value `open` returned to
 * this extension for this workspace — and pi (via agentManager) consumes it as a
 * full `--session <path>` argument, so we can't accept a bare id here (agentManager
 * doesn't resolve one; that would need an off-limits agentManager change). Instead
 * we canonicalize the path and require it to live inside this workspace's
 * `<cwd>/.cate/pi-agent/` dir — the ONLY place pi writes session jsonl for this
 * workspace (see agentDir.ts hostAgentDir/hostSessionsDir). Anything absolute-but-
 * outside, traversing (`..`), or NUL-bearing is rejected.
 *
 * Invariant relied on: every session file a legitimate `open` hands back is an
 * absolute path under `<cwd>/.cate/pi-agent/`, and pi never writes this
 * workspace's sessions elsewhere. Residual gap: the pi-agent dir is shared by ALL
 * extensions in a workspace (session files are keyed by cwd, not extensionId), so
 * this stops cross-WORKSPACE / arbitrary-file reads but not one consented
 * extension resuming another extension's session within the SAME workspace. Fully
 * closing that would require per-extension session keying inside agentManager
 * (out of scope for this file) and remains advisable.
 *
 * Returns the canonicalized path when valid, or null to reject.
 */
function boundedResumePath(resume: string, runtimeId: string, cwd: string): string | null {
  if (resume.includes('\0')) return null
  // Session paths live on the host that runs pi: native separators for the local
  // runtime, POSIX for a remote host. Match hostAgentDir's flavor choice.
  const p = runtimeId === LOCAL_RUNTIME_ID ? path : path.posix
  if (!p.isAbsolute(resume)) return null
  const normalized = p.normalize(resume)
  const root = p.join(cwd, '.cate', 'pi-agent')
  if (normalized !== root && !normalized.startsWith(root + p.sep)) return null
  return normalized
}

/** Ask the user (once per app session) whether `extensionId` may use
 *  `capability`. Returns true if already granted or the user allows. */
async function ensureConsent(extensionId: string, capability: ConsentCapability): Promise<boolean> {
  let granted = consentGranted.get(capability)
  if (!granted) consentGranted.set(capability, (granted = new Set()))
  if (granted.has(extensionId)) return true
  const name = extensionManager.getManifest(extensionId)?.name ?? extensionId
  const prompt = CONSENT_PROMPTS[capability]
  const win = getActiveMainWindow()
  const opts = {
    type: 'question' as const,
    buttons: ['Allow', 'Deny'],
    defaultId: 0,
    cancelId: 1,
    title: prompt.title,
    message: prompt.message(name),
    detail: prompt.detail,
  }
  const { response } =
    win && !win.isDestroyed() ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts)
  if (response === 0) {
    granted.add(extensionId)
    return true
  }
  return false
}

/**
 * Scope-based cate.* dispatch core, shared by the IPC handler (guest webview)
 * and the CATE_API reverse endpoint (extension server). The scope carries the
 * caller identity + a `forward` for state-mutating methods, so this never
 * touches an IPC event directly.
 */
export async function dispatchCateInvoke(
  scope: InvokeScope,
  method: string,
  args: unknown,
): Promise<InvokeResult> {
  const { extensionId, workspaceId, panelId } = scope

  // Security: only enabled, known extensions may call the host. First-party
  // (terminal/agent) callers are trusted and skip this gate.
  if (scope.caller !== 'first-party' && (!extensionManager.isKnown(extensionId) || !extensionManager.isEnabled(extensionId))) {
    return { error: 'not-enabled', method }
  }

  // Security: enforce the caller's declared scopes. First-party callers carry
  // their own `grantedScopes`; extensions use their manifest's `cateApi`.
  // version + the panel.* self-control methods are always allowed; an unknown
  // method is rejected as unsupported before any scope check so callers get the
  // clearer error.
  const required = requiredScopeFor(method)
  if (required === undefined) return unsupported(method)
  const declared = scope.grantedScopes ?? extensionManager.getManifest(extensionId)?.cateApi
  if (required !== null && !scopeGranted(declared, required)) {
    return { error: 'scope-denied', method }
  }
  // panel.setTitle is scope-free only for a panel changing its own identity.
  // Addressing another panel (the CLI's --panel form) requires the panel scope.
  if (method === 'cate.panel.setTitle') {
    const target = (args as { panelId?: unknown } | null)?.panelId
    if (typeof target === 'string' && target !== panelId && !scopeGranted(declared, 'panel')) {
      return { error: 'scope-denied', method }
    }
  }

  // Security: the first-party CLI permission matrix (Settings → CLI) — one
  // read/control cell per surface, checked before anything is touched. A method
  // no row covers is governed by scopes alone. Extensions never reach this:
  // their gate is manifest scopes plus, for browser/agent, a consent prompt.
  if (scope.caller === 'first-party') {
    const cell = cliPermissionForMethod(method)
    if (cell && getSetting(cell.key) !== true) {
      return { error: cliPermissionDenied(cell), method }
    }
  }

  // Storage (handled in main, backed by storage.ts). Routed by prefix — mirrors
  // requiredScopeFor's storage.* branch — so dispatchStorage's switch is the sole
  // enumeration of the six storage methods.
  if (method.startsWith('cate.storage.')) {
    return await dispatchStorage(method, panelId ?? '', args, extensionId, workspaceId)
  }

  // Browser control: route to the OWNER window of the addressed browser panel
  // (args.panelId), or the active main window when unaddressed. `panelId` on the
  // forwarded payload stays the caller's own origin panel (empty for terminals).
  if (method.startsWith('cate.browser.')) {
    const a = (args ?? {}) as { panelId?: string }
    const target = resolvePanelTargetWindow(typeof a.panelId === 'string' ? a.panelId : undefined, 'browser')
    if ('error' in target) return { error: target.error, method }
    // Two flavors of the same gate: extensions get a one-time-per-session
    // consent prompt (mirroring agent); the first-party CLI was already checked
    // against its Browser read/control cells above, so it needs no prompt.
    if (scope.caller !== 'first-party' && !(await ensureConsent(extensionId, 'browser'))) {
      return { error: 'consent-denied', method }
    }
    const result = await forwardToOwner(target.wc, { extensionId, workspaceId, panelId: panelId ?? '', method, args })
    if (method === 'cate.browser.open' && !a.panelId && result && typeof result === 'object') {
      const opened = result as { panelId?: unknown; url?: unknown }
      if (typeof opened.panelId === 'string') {
        upsertWindowPanel(target.ownerWindowId, {
          panelId: opened.panelId,
          type: 'browser',
          title: typeof opened.url === 'string' ? opened.url : 'Browser',
          workspaceId,
          url: typeof opened.url === 'string' ? opened.url : '',
          focused: false,
        })
      }
    }
    return result
  }

  // Terminal control: route to the OWNER window of the addressed terminal panel
  // (args.panelId), or the active main window when unaddressed (`read` resolves
  // the focused terminal renderer-side). Both halves are permission cells
  // (Settings → CLI), checked above: Read (on by default — scrollback may hold
  // printed secrets) and Control (OFF by default — keystrokes into a live shell).
  if (method.startsWith('cate.terminal.')) {
    // First-party (CLI) only for now: an extension's manifest scopes are
    // self-declared, and the terminal consent story (prompt vs toggle) is
    // deferred until a real extension consumer exists. Revisit alongside
    // ConsentCapability if one appears.
    if (scope.caller !== 'first-party') {
      return { error: 'terminal-first-party-only', method }
    }
    const a = (args ?? {}) as { panelId?: string }
    const target = resolvePanelTargetWindow(typeof a.panelId === 'string' ? a.panelId : undefined, 'terminal')
    if ('error' in target) return { error: target.error, method }
    return forwardToOwner(target.wc, { extensionId, workspaceId, panelId: panelId ?? '', method, args })
  }

  switch (method) {
    case 'cate.version':
      return CATE_API_VERSION

    case 'cate.workspace.get': {
      const info = getWorkspaceInfo(workspaceId)
      if (!info) return { rootPath: null, branch: null, worktree: null }
      const { path: rootPath } = parseLocator(info.rootPath)
      // branch/worktree are optional in Phase 1; left null (renderer/git owns them).
      return { rootPath: rootPath || null, branch: null, worktree: null }
    }

    case 'cate.theme.get': {
      const theme = resolveActiveTheme(getAllSettings())
      return { id: theme.id, type: theme.type, app: theme.app, terminal: theme.terminal }
    }

    case 'cate.ui.notify': {
      const a = (args ?? {}) as { message?: string; level?: string }
      const message = typeof a.message === 'string' ? a.message : ''
      // Reuse the shared OS-notification path (GC-reference guard + dock bounce)
      // and honor the user's master notifications toggle — an extension can't
      // notify when the user has notifications off.
      if (message && getSetting('notificationsEnabled')) {
        try {
          showOsNotification({ title: extensionManager.getManifest(extensionId)?.name ?? 'Extension', body: message })
        } catch { /* best effort */ }
      }
      log.info('[extensions] %s notify (%s): %s', extensionId, a.level ?? 'info', message)
      return { ok: true }
    }

    case 'cate.panel.list': {
      // Read the active renderer synchronously so a just-created panel is
      // visible before the 200ms cross-window discovery report lands, then add
      // panels owned by detached/other windows from main's authoritative union.
      const local = await scope.forward({ extensionId, workspaceId, panelId: panelId ?? '', method, args })
      if (!Array.isArray(local)) return local
      const rows = [...local] as Array<Record<string, unknown>>
      const seen = new Set(rows.map((row) => row.panelId).filter((id): id is string => typeof id === 'string'))
      for (const panel of getWindowPanels()) {
        if (panel.workspaceId !== workspaceId || seen.has(panel.panelId)) continue
        rows.push({
          panelId: panel.panelId,
          type: panel.type,
          title: panel.title,
          focused: panel.focused === true,
          ...(panel.filePath ? { filePath: panel.filePath } : {}),
          ...(panel.type === 'browser' ? { url: panel.url ?? '' } : {}),
        })
        seen.add(panel.panelId)
      }
      return rows
    }

    case 'cate.panel.focus': {
      const a = (args ?? {}) as { panelId?: unknown }
      const targetPanelId = typeof a.panelId === 'string' ? a.panelId : ''
      if (!targetPanelId) return { error: 'bad-args', method }
      const owner = getWindowPanels().find((p) => p.panelId === targetPanelId && p.workspaceId === workspaceId)
      if (owner) {
        return revealWindowPanel(targetPanelId) ? { ok: true } : { error: 'panel-not-revealable', method }
      }
      // Fresh local panels can beat the debounced cross-window report.
      return scope.forward({ extensionId, workspaceId, panelId: panelId ?? '', method, args })
    }

    case 'cate.panel.setTitle':
    case 'cate.panel.close': {
      const a = (args ?? {}) as { panelId?: unknown }
      const targetPanelId = typeof a.panelId === 'string' && a.panelId ? a.panelId : panelId ?? ''
      if (!targetPanelId) return { error: 'bad-args', method }
      const routedArgs = { ...((args ?? {}) as Record<string, unknown>), panelId: targetPanelId }
      const owner = getWindowPanels().find((p) => p.panelId === targetPanelId && p.workspaceId === workspaceId)
      const win = owner ? getWindow(owner.ownerWindowId) : undefined
      const result = await (win && !win.isDestroyed()
        ? forwardToOwner(win.webContents, {
            extensionId,
            workspaceId,
            panelId: panelId ?? '',
            method,
            args: routedArgs,
          })
        // Same fresh-panel race as list/focus: try the active workspace renderer.
        : scope.forward({ extensionId, workspaceId, panelId: panelId ?? '', method, args: routedArgs }))
      // Evict a successfully closed panel from the cross-window union right
      // away — the owner's debounced report would otherwise keep serving the
      // stale row to panel.list, so a close-then-verify caller reads the panel
      // as still open (the eviction mirror of upsertWindowPanel on create).
      if (method === 'cate.panel.close' && !(result && typeof result === 'object' && 'error' in result)) {
        removeWindowPanel(targetPanelId)
      }
      return result
    }

    // --- Agent: drive a pi session through the bundled pi --------------------
    // pi owns all conversation state on its session jsonl; Cate only holds the
    // live client. `open` returns a handle (the jsonl path) the extension reuses
    // for `send` and can persist to `resume` later. There is no one-shot `run`
    // sugar — compose open -> send -> dispose.
    case 'cate.agent.open': {
      const a = (args ?? {}) as { resume?: unknown }
      const rawResume = typeof a.resume === 'string' && a.resume ? a.resume : undefined
      const info = getWorkspaceInfo(workspaceId)
      if (!info) return { error: 'no-workspace', method }
      // Security: a `resume` handle is forwarded to pi as a full session-file path,
      // so bound it to THIS workspace's pi-agent dir before it can reach the agent
      // (or prompt for consent) — reject cross-workspace / arbitrary-file handles.
      let resume: string | undefined
      if (rawResume !== undefined) {
        const { runtimeId, path: cwd } = parseLocator(info.rootPath)
        const bounded = boundedResumePath(rawResume, runtimeId, cwd)
        if (!bounded) return { error: 'invalid-resume', method }
        resume = bounded
      }
      const win = requireHostWindow()
      if (!win) return { error: 'no-host-window', method }
      if (!(await ensureConsent(extensionId, 'agent'))) return { error: 'consent-denied', method }
      try {
        return await agentManager.openForExtension({
          workspaceId, locator: info.rootPath, extensionId, sender: win.webContents, resume,
        })
      } catch (err) {
        return agentError(err, method)
      }
    }

    case 'cate.agent.send': {
      const a = (args ?? {}) as { sessionId?: unknown; prompt?: unknown }
      const sessionId = typeof a.sessionId === 'string' ? a.sessionId : ''
      const promptText = typeof a.prompt === 'string' ? a.prompt.trim() : ''
      if (!sessionId || !promptText) return { error: 'bad-args', method }
      try {
        return await agentManager.sendForExtension({ extensionId, sessionId, text: promptText })
      } catch (err) {
        return agentError(err, method)
      }
    }

    case 'cate.agent.dispose': {
      const a = (args ?? {}) as { sessionId?: unknown }
      const sessionId = typeof a.sessionId === 'string' ? a.sessionId : ''
      if (!sessionId) return { error: 'bad-args', method }
      await agentManager.disposeForExtension({ extensionId, sessionId })
      return { ok: true }
    }

    case 'cate.agent.cancel': {
      await agentManager.cancelForExtension(extensionId)
      return { ok: true }
    }

    default:
      // Forward state-mutating methods (strip the leading `cate.`) to the owner.
      if (FORWARDED_METHODS.has(method.replace(/^cate\./, ''))) {
        const result = await scope.forward({ extensionId, workspaceId, panelId: panelId ?? '', method, args })
        // A create result is meant to be used immediately by the next CLI
        // command. The renderer's full panel report is debounced, so register a
        // provisional row now; otherwise `panel create browser` followed by
        // `browser open --panel <returned-id>` (and the terminal equivalent)
        // races the owner lookup and returns no-such-browser/terminal. The next
        // normal report replaces this row with the complete panel metadata.
        if (method === 'cate.canvas.createPanel' && result && typeof result === 'object') {
          const created = result as { panelId?: unknown }
          const a = (args ?? {}) as { type?: unknown; url?: unknown }
          const win = getActiveMainWindow()
          if (
            typeof created.panelId === 'string' &&
            typeof a.type === 'string' &&
            win && !win.isDestroyed()
          ) {
            upsertWindowPanel(win.id, {
              panelId: created.panelId,
              type: a.type as PanelType,
              title: typeof a.url === 'string' ? a.url : a.type,
              workspaceId,
              ...(a.type === 'browser' && typeof a.url === 'string' ? { url: a.url } : {}),
              focused: false,
            })
          }
        }
        return result
      }
      return unsupported(method)
  }
}

async function dispatchInvoke(
  payload: InvokePayload,
): Promise<InvokeResult> {
  return dispatchCateInvoke(
    {
      extensionId: payload.extensionId,
      workspaceId: payload.workspaceId,
      panelId: payload.panelId,
      // CATE_HOST_INVOKE arrives from the extension WEBVIEW guest, so
      // `event.sender` is the guest's WebContents — which does NOT host the
      // useCateHostActionResponder. Forward state-mutating methods to the active
      // main window's renderer instead (where the responder is mounted), mirroring
      // the CATE_API reverse path in cateApiReverse.ts.
      forward: forwardToActiveWindow,
    },
    payload.method,
    payload.args,
  )
}

async function dispatchStorage(
  method: string,
  panelId: string,
  args: unknown,
  extensionId: string,
  workspaceId: string,
): Promise<InvokeResult> {
  const storage = await getExtensionStorage(extensionId, workspaceId)
  if (!storage) return { error: 'no-storage', method }
  const a = (args ?? {}) as { key?: string; value?: unknown }
  switch (method) {
    case 'cate.storage.get':
      return storage.get(String(a.key))
    case 'cate.storage.set':
      storage.set(String(a.key), a.value)
      return { ok: true }
    case 'cate.storage.delete':
      storage.delete(String(a.key))
      return { ok: true }
    case 'cate.storage.keys':
      return storage.keys()
    case 'cate.storage.panel.get':
      return storage.panelGet(panelId, String(a.key))
    case 'cate.storage.panel.set':
      storage.panelSet(panelId, String(a.key), a.value)
      return { ok: true }
    default:
      return unsupported(method)
  }
}

// ---------------------------------------------------------------------------
// Guest identity + per-webContents destroyed cleanup
// ---------------------------------------------------------------------------

/** Derive the AUTHORITATIVE (extensionId, workspaceId) for a calling guest from
 *  its proxy URL routeToken (the trusted source), and reject a payload that
 *  self-asserts a different identity. Shared by CATE_HOST_INVOKE and
 *  CATE_HOST_SUBSCRIBE so a guest can't spoof another extension's id via the
 *  query string its preload forwards. Returns the trusted identity, or an error
 *  CODE the caller wraps in its own result shape (invoke also attaches `method`). */
function authenticateGuest(
  event: { sender: WebContents },
  payload: { extensionId?: string; workspaceId?: string } | null | undefined,
): { identity: { extensionId: string; workspaceId: string } } | { error: string } {
  const identity = identityForGuestUrl(event.sender.getURL())
  if (!identity) return { error: 'unknown-guest' }
  if (payload?.extensionId !== identity.extensionId || payload?.workspaceId !== identity.workspaceId) {
    return { error: 'identity-mismatch' }
  }
  return { identity }
}

// Per-webContents 'destroyed' cleanups. A webContents may both back server
// panels (proxy-url path) AND hold subscriptions (subscribe path); when it goes
// away BOTH must tear down, but under a SINGLE 'destroyed' listener — a fresh
// listener per proxy-resolve or subscribe would stack across reuses and trip
// Node's MaxListenersExceededWarning. First sighting of a webContents hooks the
// listener; later ones compose their cleanup into the same set. The cleanups are
// wc-scoped and idempotent, so they run to the same effect however many times a
// path registered.
const destroyCleanups = new Map<number, Set<() => void>>()

function onceDestroyed(wc: WebContents, cleanup: () => void): void {
  const existing = destroyCleanups.get(wc.id)
  if (existing) {
    existing.add(cleanup)
    return
  }
  const cleanups = new Set<() => void>([cleanup])
  destroyCleanups.set(wc.id, cleanups)
  const wcId = wc.id
  wc.once('destroyed', () => {
    destroyCleanups.delete(wcId)
    for (const fn of cleanups) {
      try { fn() } catch { /* noop */ }
    }
  })
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerExtensionHandlers(): void {
  // Subscribe to host-connect events so enabled extensions are eagerly
  // provisioned onto each runtime (local + remote) as it comes online.
  extensionManager.init()

  // Prime the registry from settings (sideload folders). Best-effort; the
  // list/proxy handlers also tolerate an empty registry. On a fresh install the
  // catalog cache is empty even though a default source is configured (the
  // network fetch otherwise only happens on a manual "Refresh catalog"), so the
  // Settings UI looks like no source exists. Self-heal: if sources are
  // configured but the cache is empty, kick off one background fetch.
  // refreshCatalog() fetches, caches, re-scans and broadcasts EXTENSIONS_CHANGED
  // so the renderer updates itself. Fire-and-forget; offline failures are
  // logged, never fatal.
  void extensionManager
    .refresh()
    .then(async () => {
      if (extensionManager.getCatalogSources().length === 0) return
      const cached = await getCachedCatalog()
      if (cached.length > 0) return
      await extensionManager.refreshCatalog()
    })
    .catch((err) => log.warn('[extensions] initial refresh failed: %O', err))

  // --- Extension management ------------------------------------------------
  ipcMain.handle(EXTENSION_LIST, async () => {
    await extensionManager.refresh()
    return extensionManager.list()
  })

  ipcMain.handle(EXTENSION_ENABLE, async (_e, id: string) => {
    await extensionManager.enable(id)
  })

  ipcMain.handle(EXTENSION_DISABLE, async (_e, id: string) => {
    extensionManager.disable(id)
  })

  ipcMain.handle(EXTENSION_ADD_SIDELOAD, async (_e, folderPath: string) => {
    return extensionManager.addSideload(folderPath)
  })

  ipcMain.handle(EXTENSION_REMOVE_SIDELOAD, async (_e, folderPath: string) => {
    await extensionManager.removeSideload(folderPath)
  })

  // Re-fetch every catalog source, cache the merged index, re-scan, broadcast.
  ipcMain.handle(EXTENSION_CATALOG_REFRESH, async () => {
    return extensionManager.refreshCatalog()
  })

  // Download + extract a catalog extension (without enabling it).
  ipcMain.handle(EXTENSION_INSTALL, async (_e, id: string) => {
    try {
      await extensionManager.installCatalogExtension(id)
      return { ok: true }
    } catch (err) {
      log.warn('[extensions] install %s failed: %O', id, err)
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // Disable + remove an installed catalog extension from disk.
  ipcMain.handle(EXTENSION_UNINSTALL, async (_e, id: string) => {
    try {
      await extensionManager.uninstall(id)
      return { ok: true }
    } catch (err) {
      log.warn('[extensions] uninstall %s failed: %O', id, err)
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // Re-download the installed version (repair a corrupt install).
  ipcMain.handle(EXTENSION_REINSTALL, async (_e, id: string) => {
    return extensionManager.reinstall(id)
  })

  // Install the catalog's newer version and drop the old one.
  ipcMain.handle(EXTENSION_UPDATE, async (_e, id: string) => {
    return extensionManager.update(id)
  })

  ipcMain.handle(EXTENSION_ADD_CATALOG_SOURCE, async (_e, url: string) => {
    return extensionManager.addCatalogSource(url)
  })

  ipcMain.handle(EXTENSION_REMOVE_CATALOG_SOURCE, async (_e, url: string) => {
    await extensionManager.removeCatalogSource(url)
  })

  ipcMain.handle(EXTENSION_CATALOG_SOURCES, async () => {
    return extensionManager.getCatalogSources()
  })

  ipcMain.handle(
    EXTENSION_PROXY_URL,
    async (event, args: { extensionId: string; workspaceId: string; panelId: string }) => {
      await extensionManager.refresh()
      // Tie a server-backed extension's lifetime to the owning window: when its
      // webContents is destroyed (window closed) leave every panel it owns so
      // the grace timer / server stop fires.
      const sender = event.sender
      const wcId = sender.id
      onceDestroyed(sender, () => extensionServerManager.disposeForWebContents(wcId))
      // getProxyUrlFor joins+spawns for server-backed extensions; it may return
      // { error } for a failed spawn, which the panel renders.
      return getProxyUrlFor({ ...args, sender })
    },
  )

  // A server-backed panel unmounted (renderer reports it). Start the grace timer
  // so a quick reopen reuses the live server but a real close stops it.
  ipcMain.on(
    EXTENSION_PANEL_CLOSED,
    (_e, args: { extensionId: string; workspaceId: string; panelId: string }) => {
      if (!args?.extensionId) return
      extensionServerManager.leavePanel(args.extensionId, args.workspaceId, args.panelId)
    },
  )

  // Manual restart of a crashed/errored server (resets the crash budget).
  ipcMain.handle(
    EXTENSION_SERVER_RESTART,
    async (_e, args: { extensionId: string; workspaceId: string }) => {
      if (!args?.extensionId) return { ok: false, error: 'bad-args' }
      return extensionServerManager.restart(args.extensionId, args.workspaceId)
    },
  )

  // --- cateHost reverse API (guest -> main) --------------------------------
  ipcMain.handle(CATE_HOST_INVOKE, async (event, payload: InvokePayload) => {
    if (!payload || typeof payload !== 'object') return { error: 'bad-payload' }
    // Security: derive the AUTHORITATIVE (extensionId, workspaceId) from the
    // calling guest's URL (the opaque proxy routeToken), NOT the self-asserted
    // payload — a malicious guest can spoof another extension's id in the query
    // string the preload reads. Reject if the guest isn't a known proxy route or
    // the payload disagrees with its true identity.
    const auth = authenticateGuest(event, payload)
    if ('error' in auth) return { error: auth.error, method: payload.method }
    try {
      return await dispatchInvoke({ ...payload, ...auth.identity })
    } catch (err) {
      log.warn('[extensions] invoke %s failed: %O', payload.method, err)
      return { error: 'internal', method: payload.method }
    }
  })

  ipcMain.handle(
    CATE_HOST_SUBSCRIBE,
    async (event, payload: { extensionId: string; workspaceId: string; panelId: string; topic: string }) => {
      const { panelId, topic } = payload ?? ({} as typeof payload)
      // Security: like CATE_HOST_INVOKE, take the authoritative identity from the
      // guest's URL (not the self-asserted payload) so a guest can't subscribe to
      // another extension's change stream.
      const auth = authenticateGuest(event, payload)
      if ('error' in auth) return { error: auth.error }
      const { extensionId, workspaceId } = auth.identity
      if (!extensionManager.isKnown(extensionId) || !extensionManager.isEnabled(extensionId)) {
        return { error: 'not-enabled' }
      }
      // Phase 1 supports the storage.change topic, fed by the storage watcher.
      if (topic !== 'storage.change') return { error: 'unsupported', topic }
      const storage = await getExtensionStorage(extensionId, workspaceId)
      if (!storage) return { error: 'no-storage' }
      const wc = event.sender
      const dispose = storage.onChange(() => {
        try {
          wc.send(CATE_HOST_EVENT, { panelId, topic: 'storage.change', payload: {} })
        } catch { /* guest gone */ }
      })
      const sub: Subscription = { wc, extensionId, workspaceId, panelId, topic, dispose }
      subscriptions.add(sub)
      // Auto-clean when the guest webContents is destroyed. onceDestroyed hooks
      // the listener ONCE per webContents — a fresh listener per subscribe would
      // stack up across subscribe/unsubscribe cycles (unsubscribe removes the
      // Subscription, not this hook) and trip MaxListenersExceededWarning.
      onceDestroyed(wc, () => disposeSubscriptionsFor(wc))
      return { ok: true }
    },
  )

  ipcMain.handle(
    CATE_HOST_UNSUBSCRIBE,
    async (event, payload: { panelId?: string; topic?: string }) => {
      const wc = event.sender
      for (const sub of [...subscriptions]) {
        if (sub.wc !== wc) continue
        if (payload?.panelId && sub.panelId !== payload.panelId) continue
        if (payload?.topic && sub.topic !== payload.topic) continue
        try { sub.dispose() } catch { /* noop */ }
        subscriptions.delete(sub)
      }
      return { ok: true }
    },
  )

  // --- Forward reply (renderer -> main) ------------------------------------
  ipcMain.on(
    CATE_HOST_FORWARD_REPLY,
    (_event, payload: { requestId: string; ok: boolean; result?: unknown; error?: string }) => {
      const pending = pendingForwards.get(payload?.requestId)
      if (!pending) return
      clearTimeout(pending.timer)
      pendingForwards.delete(payload.requestId)
      pending.resolve(payload.ok ? payload.result : { error: payload.error ?? 'forward-failed' })
    },
  )

  // Drop pending forwards / subscriptions on quit so timers don't keep the
  // event loop alive.
  app.on('will-quit', () => {
    for (const { timer } of pendingForwards.values()) clearTimeout(timer)
    pendingForwards.clear()
    for (const sub of subscriptions) { try { sub.dispose() } catch { /* noop */ } }
    subscriptions.clear()
  })
}
