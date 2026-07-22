// =============================================================================
// cateHost preload — injected into extension webview guests. Exposes the `cate`
// global, a thin promise-returning shim over the CATE_HOST_INVOKE IPC channel.
//
// The guest identity (extensionId / workspaceId / panelId) is read from the
// webview URL's query string (set by proxyServer.getProxyUrlFor):
//   ?cateExt=<id>&cateWs=<encoded workspaceId>&catePanel=<panelId>
//
// Methods not yet supported in Phase 1 still exist and resolve with an
// { error: 'unsupported' } result rather than being absent, so feature
// detection via cate.version works.
// =============================================================================

import { contextBridge, ipcRenderer } from 'electron'
import type {
  CodingTurnResult,
  CateBrowserSnapshot,
  CateDroppedFile,
  CateHost,
  CateHostTheme,
  CateHostWorkspace,
  CatePanelInfo,
} from '../shared/cate-host-api'

// Channel names are inlined (NOT imported from ../shared/ipc-channels) on
// purpose: this is a SECOND preload entry, and sharing a runtime module with
// src/preload/index.ts makes the bundler hoist it into a shared chunk that a
// sandboxed preload can't load — which breaks the main window's electronAPI.
// Keep these in sync with the CATE_HOST_* constants in src/shared/ipc-channels.ts.
const CATE_HOST_INVOKE = 'cate:invoke'
const CATE_HOST_SUBSCRIBE = 'cate:subscribe'
const CATE_HOST_UNSUBSCRIBE = 'cate:unsubscribe'
const CATE_HOST_EVENT = 'cate:event'

const params = new URLSearchParams(window.location.search)
const extensionId = params.get('cateExt') ?? ''
const workspaceId = params.get('cateWs') ?? ''
const panelId = params.get('catePanel') ?? ''

/** One reverse-API call to main. */
function invoke(method: string, args?: unknown): Promise<unknown> {
  return ipcRenderer.invoke(CATE_HOST_INVOKE, { extensionId, workspaceId, panelId, method, args })
}

const api: CateHost = {
  version: () => invoke('cate.version') as Promise<number>,

  panel: {
    id: panelId,
    setTitle: (title: string) => invoke('cate.panel.setTitle', { title }).then(() => undefined),
    list: () => invoke('cate.panel.list') as Promise<CatePanelInfo[]>,
    focus: (targetPanelId: string) => invoke('cate.panel.focus', { panelId: targetPanelId }),
    close: (targetPanelId: string) => invoke('cate.panel.close', { panelId: targetPanelId }),
  },

  workspace: {
    get: () => invoke('cate.workspace.get') as Promise<CateHostWorkspace>,
  },

  theme: {
    get: () => invoke('cate.theme.get') as Promise<CateHostTheme>,
  },

  editor: {
    openFile: (path: string, opts?: { line?: number }) => invoke('cate.editor.openFile', { path, ...opts }),
  },

  canvas: {
    createPanel: (
      type: string,
      opts?: {
        position?: { x: number; y: number }
        url?: string
        filePath?: string
        extensionId?: string
        extensionPanelId?: string
      },
    ) => invoke('cate.canvas.createPanel', { type, ...(opts ?? {}) }),
  },

  ui: {
    notify: (message: string, level?: 'info' | 'warn' | 'error') =>
      invoke('cate.ui.notify', { message, level }),
  },

  agent: {
    open: (opts?: { resume?: string }) =>
      invoke('cate.agent.open', { resume: opts?.resume }) as Promise<{ sessionId: string } | { error: string }>,
    send: (sessionId: string, prompt: string) =>
      invoke('cate.agent.send', { sessionId, prompt }) as Promise<CodingTurnResult | { error: string }>,
    dispose: (sessionId: string) => invoke('cate.agent.dispose', { sessionId }),
    cancel: () => invoke('cate.agent.cancel'),
  },

  browser: {
    open: (opts: { url: string; panelId?: string }) =>
      invoke('cate.browser.open', opts) as Promise<{ panelId: string; url: string }>,
    reload: (opts?: { panelId?: string }) => invoke('cate.browser.reload', opts) as Promise<{ ok: true }>,
    screenshot: (opts?: { panelId?: string }) =>
      invoke('cate.browser.screenshot', opts) as Promise<{ path: string }>,
    snapshot: (opts?: { panelId?: string }) =>
      invoke('cate.browser.snapshot', opts) as Promise<CateBrowserSnapshot>,
    click: (opts: { ref: string; panelId?: string }) =>
      invoke('cate.browser.click', opts) as Promise<{ ok: true }>,
    type: (opts: { ref: string; text: string; panelId?: string }) =>
      invoke('cate.browser.type', opts) as Promise<{ ok: true }>,
    wait: (opts?: { panelId?: string; timeoutMs?: number }) =>
      invoke('cate.browser.wait', opts) as Promise<{ url: string; title: string; loading: false }>,
    press: (opts: { key: string; ref?: string; panelId?: string }) =>
      invoke('cate.browser.press', opts) as Promise<{ ok: true }>,
  },

  files: {
    onDrop: (cb: (files: CateDroppedFile[]) => void) => {
      const listener = (
        _e: Electron.IpcRendererEvent,
        payload: { panelId: string; topic: string; payload?: { files?: CateDroppedFile[] } },
      ): void => {
        if (payload?.topic === 'files.drop' && payload.panelId === panelId) {
          cb(Array.isArray(payload.payload?.files) ? (payload.payload!.files as CateDroppedFile[]) : [])
        }
      }
      ipcRenderer.on(CATE_HOST_EVENT, listener)
      return () => ipcRenderer.removeListener(CATE_HOST_EVENT, listener)
    },
  },

  storage: {
    get: (key: string) => invoke('cate.storage.get', { key }),
    set: (key: string, value: unknown) => invoke('cate.storage.set', { key, value }).then(() => undefined),
    delete: (key: string) => invoke('cate.storage.delete', { key }).then(() => undefined),
    keys: () => invoke('cate.storage.keys') as Promise<string[]>,
    panel: {
      get: (key: string) => invoke('cate.storage.panel.get', { key }),
      set: (key: string, value: unknown) =>
        invoke('cate.storage.panel.set', { key, value }).then(() => undefined),
    },
    onChange: (cb: (key?: string) => void) => {
      const listener = (
        _e: Electron.IpcRendererEvent,
        payload: { panelId: string; topic: string; payload?: { key?: string } },
      ): void => {
        if (payload?.topic === 'storage.change' && payload.panelId === panelId) {
          cb(payload.payload?.key)
        }
      }
      ipcRenderer.on(CATE_HOST_EVENT, listener)
      void ipcRenderer.invoke(CATE_HOST_SUBSCRIBE, {
        extensionId,
        workspaceId,
        panelId,
        topic: 'storage.change',
      })
      return () => {
        ipcRenderer.removeListener(CATE_HOST_EVENT, listener)
        void ipcRenderer.invoke(CATE_HOST_UNSUBSCRIBE, { panelId, topic: 'storage.change' })
      }
    },
  },
}

contextBridge.exposeInMainWorld('cate', api)
