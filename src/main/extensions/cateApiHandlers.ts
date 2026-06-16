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
//   - Forwarded to the owning renderer (they mutate renderer state):
//     editor.openFile, canvas.createPanel, panel.setTitle
//   - Anything else: { error: 'unsupported', method }
//
// Every invoke validates the extension is enabled before serving.
// =============================================================================

import { ipcMain, app, type WebContents } from 'electron'
import { randomUUID } from 'crypto'
import log from '../logger'
import {
  EXTENSION_LIST,
  EXTENSION_ENABLE,
  EXTENSION_DISABLE,
  EXTENSION_ADD_SIDELOAD,
  EXTENSION_REMOVE_SIDELOAD,
  EXTENSION_CATALOG_REFRESH,
  EXTENSION_INSTALL,
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
import { getProxyUrlFor } from './proxyServer'
import { extensionServerManager } from './ExtensionServerManager'
import { getExtensionStorage } from './storage'
import { getWorkspaceInfo } from '../workspaceManager'
import { getActiveMainWindow } from '../windowRegistry'
import { parseLocator } from '../runtime/locator'
import { getAllSettings, getSetting } from '../settingsFile'
import { resolveActiveTheme } from '../themeBootCache'
import { showOsNotification } from '../ipc/notifications'

/** Bumped when the cateHost API surface changes incompatibly. Guests use
 *  `cate.version` for feature detection. */
const CATE_API_VERSION = 1

const FORWARD_TIMEOUT_MS = 10_000

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

// ---------------------------------------------------------------------------
// Method dispatch
// ---------------------------------------------------------------------------

const FORWARDED_METHODS = new Set([
  'editor.openFile',
  'canvas.createPanel',
  'panel.setTitle',
])

function unsupported(method: string): InvokeResult {
  return { error: 'unsupported', method }
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

  // Security: only enabled, known extensions may call the host.
  if (!extensionManager.isKnown(extensionId) || !extensionManager.isEnabled(extensionId)) {
    return { error: 'not-enabled', method }
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

    // --- Storage (handled in main, backed by storage.ts) --------------------
    case 'cate.storage.get':
    case 'cate.storage.set':
    case 'cate.storage.delete':
    case 'cate.storage.keys':
    case 'cate.storage.panel.get':
    case 'cate.storage.panel.set':
      return dispatchStorage(method, panelId ?? '', args, extensionId, workspaceId)

    default:
      // Forward state-mutating methods (strip the leading `cate.`) to the owner.
      if (FORWARDED_METHODS.has(method.replace(/^cate\./, ''))) {
        return scope.forward({ extensionId, workspaceId, panelId: panelId ?? '', method, args })
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
      forward: (p) => {
        const win = getActiveMainWindow()
        if (!win || win.isDestroyed()) {
          return Promise.resolve({ error: 'no-host-window', method: p.method })
        }
        return forwardToOwner(win.webContents, p)
      },
    },
    payload.method,
    payload.args,
  )
}

function dispatchStorage(
  method: string,
  panelId: string,
  args: unknown,
  extensionId: string,
  workspaceId: string,
): InvokeResult {
  const storage = getExtensionStorage(extensionId, workspaceId)
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
// Registration
// ---------------------------------------------------------------------------

export function registerExtensionHandlers(): void {
  // Prime the registry from settings (sideload folders). Best-effort; the
  // list/proxy handlers also tolerate an empty registry.
  void extensionManager.refresh().catch((err) =>
    log.warn('[extensions] initial refresh failed: %O', err),
  )

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

  ipcMain.handle(EXTENSION_ADD_CATALOG_SOURCE, async (_e, url: string) => {
    return extensionManager.addCatalogSource(url)
  })

  ipcMain.handle(EXTENSION_REMOVE_CATALOG_SOURCE, async (_e, url: string) => {
    await extensionManager.removeCatalogSource(url)
  })

  ipcMain.handle(EXTENSION_CATALOG_SOURCES, async () => {
    return extensionManager.getCatalogSources()
  })

  // webContents we've hooked 'destroyed' on, so a window hosting many extension
  // panels registers a single listener (which leaves all of its server-backed
  // panels) rather than one per proxy-url resolve.
  const hookedExtSenders = new Set<number>()

  ipcMain.handle(
    EXTENSION_PROXY_URL,
    async (event, args: { extensionId: string; workspaceId: string; panelId: string }) => {
      await extensionManager.refresh()
      // Tie a server-backed extension's lifetime to the owning window: when its
      // webContents is destroyed (window closed) leave every panel it owns so
      // the grace timer / server stop fires.
      const sender = event.sender
      if (!hookedExtSenders.has(sender.id)) {
        hookedExtSenders.add(sender.id)
        const wcId = sender.id
        sender.once('destroyed', () => {
          hookedExtSenders.delete(wcId)
          extensionServerManager.disposeForWebContents(wcId)
        })
      }
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
  ipcMain.handle(CATE_HOST_INVOKE, async (_event, payload: InvokePayload) => {
    if (!payload || typeof payload !== 'object') return { error: 'bad-payload' }
    try {
      return await dispatchInvoke(payload)
    } catch (err) {
      log.warn('[extensions] invoke %s failed: %O', payload.method, err)
      return { error: 'internal', method: payload.method }
    }
  })

  ipcMain.handle(
    CATE_HOST_SUBSCRIBE,
    async (event, payload: { extensionId: string; workspaceId: string; panelId: string; topic: string }) => {
      const { extensionId, workspaceId, panelId, topic } = payload ?? ({} as typeof payload)
      if (!extensionManager.isEnabled(extensionId)) return { error: 'not-enabled' }
      // Phase 1 supports the storage.change topic, fed by the storage watcher.
      if (topic !== 'storage.change') return { error: 'unsupported', topic }
      const storage = getExtensionStorage(extensionId, workspaceId)
      if (!storage) return { error: 'no-storage' }
      const wc = event.sender
      const dispose = storage.onChange(() => {
        try {
          wc.send(CATE_HOST_EVENT, { panelId, topic: 'storage.change', payload: {} })
        } catch { /* guest gone */ }
      })
      const sub: Subscription = { wc, extensionId, workspaceId, panelId, topic, dispose }
      subscriptions.add(sub)
      // Auto-clean when the guest webContents is destroyed.
      wc.once('destroyed', () => disposeSubscriptionsFor(wc))
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
