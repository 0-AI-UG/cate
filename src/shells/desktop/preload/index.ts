// The desktop preload: the desktop IPC declared in `../contract` and nothing
// else (architecture 15). Exposed as `window.cateDesktop`, plus the browser
// page bridge as `window.cateBrowserPage`. No workspace work crosses it.
//
// This entry must bundle self-contained: Electron's sandboxed preload loader
// cannot require a shared chunk (`preload.test.ts` checks it). Import only
// pure contract files and this module's own code.

import { contextBridge, ipcRenderer, webFrame, type IpcRendererEvent } from 'electron'
import { createBrowserPageBridge } from '@services/browser/desktop/preload'
import type { DesktopApi, LoopbackRequest } from '../contract/api'
import { DESKTOP_CHANNELS as C } from '../contract/channels'
import { sharedDeviceDocument } from '../contract/deviceFiles'
import { isPipeControl, pipeBytes, type PipeMessage } from '../contract/pipe'

try { performance.mark('preload-start') } catch { /* noop */ }

function listen<A extends unknown[]>(channel: string, listener: (...args: A) => void): () => void {
  const wrapped = (_event: IpcRendererEvent, ...args: unknown[]) => listener(...(args as A))
  ipcRenderer.on(channel, wrapped)
  return () => { ipcRenderer.removeListener(channel, wrapped) }
}

/** Electron prefixes errors from main; callers show the message itself. */
async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  try {
    return await ipcRenderer.invoke(channel, ...args) as T
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ''))
  }
}

// --- Pipes: one MessagePort per connection, held here so ports never cross
// the context bridge; bytes do.

const ports = new Map<string, MessagePort>()
const waiting = new Map<string, (port: MessagePort) => void>()
const early = new Map<string, PipeMessage[]>()
const pipeListeners = new Map<string, Set<(message: PipeMessage) => void>>()
const loopbackListeners = new Set<(request: LoopbackRequest) => void>()

function forget(pipe: string): void {
  ports.delete(pipe)
  waiting.delete(pipe)
  early.delete(pipe)
  pipeListeners.delete(pipe)
}

function deliver(pipe: string, message: PipeMessage): void {
  const listeners = pipeListeners.get(pipe)
  if (listeners && listeners.size > 0) for (const listener of [...listeners]) listener(message)
  else early.set(pipe, [...(early.get(pipe) ?? []), message])
}

function adopt(pipe: string, port: MessagePort | undefined): void {
  if (!port) return
  ports.set(pipe, port)
  let closed = false
  const close = (reason?: string) => {
    if (closed) return
    closed = true
    const listening = (pipeListeners.get(pipe)?.size ?? 0) > 0
    deliver(pipe, { t: 'close', ...(reason ? { reason } : {}) })
    ports.delete(pipe)
    if (listening) pipeListeners.delete(pipe)
  }
  port.onmessage = (event) => {
    const bytes = pipeBytes(event.data)
    if (bytes) deliver(pipe, bytes)
    else if (isPipeControl(event.data)) {
      if (event.data.t === 'close') close(event.data.reason)
      else deliver(pipe, event.data)
    }
  }
  port.addEventListener('close', () => close('pipe closed'))
  port.start()
  waiting.get(pipe)?.(port)
  waiting.delete(pipe)
}

ipcRenderer.on(C.pipePort, (event, meta: { pipe?: unknown }) => {
  if (typeof meta?.pipe === 'string') adopt(meta.pipe, event.ports[0])
})
ipcRenderer.on(C.loopbackRequest, (event, request: LoopbackRequest) => {
  if (typeof request?.pipe !== 'string') return
  adopt(request.pipe, event.ports[0])
  if (loopbackListeners.size === 0) {
    ports.get(request.pipe)?.postMessage({ t: 'close', reason: 'no connection in this window' })
    forget(request.pipe)
    return
  }
  for (const listener of loopbackListeners) listener({ runtimeId: request.runtimeId, port: request.port, pipe: request.pipe })
})

/** Starts a dial in main and resolves with the pipe id once its port arrived. */
async function dial(channel: string, arg: unknown): Promise<string> {
  const pipe = crypto.randomUUID()
  const arrived = new Promise<void>((resolve) => {
    if (ports.has(pipe)) resolve()
    else waiting.set(pipe, () => resolve())
  })
  try {
    await invoke(channel, pipe, arg)
  } catch (error) {
    forget(pipe)
    throw error
  }
  await arrived
  return pipe
}

const api: DesktopApi = {
  app: {
    info: () => invoke(C.appInfo),
    setQuitBlockers: (labels) => ipcRenderer.send(C.quitBlockers, labels),
    onOpenPath: (listener) => listen(C.openPath, listener),
    onOpenUrl: (listener) => listen(C.openUrl, listener),
    openRequestsReady: () => ipcRenderer.send(C.openRequestsReady),
    perf: () => invoke(C.perfGet),
    onAttention: (listener) => listen(C.appAttention, listener),
  },
  device: {
    get: (name) => invoke(C.deviceGet, name),
    set: (name, value) => invoke(C.deviceSet, name, value),
    subscribe(name, onChange) {
      const wanted = sharedDeviceDocument(name)
      return listen(C.deviceChanged, (changed: string, value: unknown) => {
        if (wanted && changed === wanted) onChange(value)
      })
    },
  },
  windows: {
    open: (request) => invoke(C.windowsOpen, request),
    close: (ref) => invoke(C.windowsClose, ref),
    focus: (ref) => invoke(C.windowsFocus, ref),
    list: () => invoke(C.windowsList),
  },
  window: {
    newMainWindow: () => invoke(C.windowNewMain),
    minimize: () => invoke(C.windowMinimize),
    toggleMaximize: () => invoke(C.windowToggleMaximize),
    close: () => invoke(C.windowClose),
    setTitle: (title) => invoke(C.windowSetTitle, title),
    state: () => invoke(C.windowState),
    onState: (listener) => listen(C.windowStateChanged, listener),
    onCloseRequested: (listener) => listen(C.windowCloseRequested, listener),
    anyFullscreen: () => ipcRenderer.sendSync(C.anyFullscreen) === true,
    setZoomFactor: (factor) => {
      if (Number.isFinite(factor) && factor > 0) webFrame.setZoomFactor(factor)
    },
  },
  menu: {
    showContextMenu: (items) => invoke(C.menuContext, items),
    barItems: () => invoke(C.menuBarItems),
    popupBarItem: (index, x, y) => invoke(C.menuPopupBarItem, index, x, y),
    runNativeAction: (action) => invoke(C.menuNativeAction, action),
    setModel: (model) => invoke(C.menuSetModel, model),
    onAction: (listener) => listen(C.menuAction, listener),
  },
  dialogs: {
    messageBox: (request) => invoke(C.dialogMessageBox, request),
    open: (request) => invoke(C.dialogOpen, request),
    pickCanvasBackground: () => invoke(C.canvasBackgroundPick),
    readCanvasBackground: (path) => invoke(C.canvasBackgroundRead, path),
    pruneCanvasBackgrounds: (keepPath) => invoke(C.canvasBackgroundPrune, keepPath),
  },
  os: {
    openExternal: (url) => invoke(C.osOpenExternal, url),
    openSettingsFile: () => invoke(C.osOpenSettingsFile),
    writeClipboard: (text) => invoke(C.clipboardWrite, text),
    readClipboard: () => invoke(C.clipboardRead),
    notify: (notification) => invoke(C.notify, notification),
    onNotificationAction: (listener) => listen(C.notificationAction, listener),
  },
  updates: {
    status: () => invoke(C.updateGetStatus),
    check: () => invoke(C.updateCheck),
    install: () => invoke(C.updateInstall),
    onStatus: (listener) => listen(C.updateStatus, listener),
  },
  analytics: {
    track: (feature, props) => ipcRenderer.send(C.analyticsTrack, feature, props),
    feedbackPending: () => invoke(C.analyticsFeedbackPending),
    submitFeedback: (feedback) => invoke(C.analyticsFeedbackSubmit, feedback),
    dismissFeedback: () => ipcRenderer.send(C.analyticsFeedbackDismiss),
    onFeedbackPrompt: (listener) => listen(C.analyticsFeedbackPrompt, listener),
  },
  capture: {
    window: (rect) => invoke(C.captureWindow, rect),
    recentScreenshots: () => invoke(C.recentScreenshots),
    onRecentScreenshots: (listener) => listen(C.recentScreenshotsChanged, listener),
    readRecentScreenshot: (id) => invoke(C.recentScreenshotRead, id),
    dragRecentScreenshot: (id) => invoke(C.recentScreenshotDrag, id),
    addAnnotatedScreenshot: (ref, png) => invoke(C.recentScreenshotAddAnnotated, ref, png),
  },
  drag: {
    start: (payload) => invoke(C.dragStart, payload),
    claim: (dragId) => invoke(C.dragClaim, dragId),
    end: (dragId) => invoke(C.dragEnd, dragId),
    cancel: (dragId) => invoke(C.dragCancel, dragId),
    onPointer: (listener) => listen(C.dragPointer, listener),
    onEnded: (listener) => listen(C.dragEnded, listener),
  },
  transports: {
    dialLocal: (root) => dial(C.dialLocal, root),
    dialNetwork: (target) => dial(C.dialNetwork, target),
    dialLoopbackTcp: (port) => dial(C.dialLoopbackTcp, port),
    pair: (request) => invoke(C.pair, request),
    onLoopbackRequest(listener) {
      loopbackListeners.add(listener)
      return () => { loopbackListeners.delete(listener) }
    },
  },
  ssh: {
    ensureRuntime: (target) => invoke(C.sshEnsureRuntime, target),
    listDir: (target, path) => invoke(C.sshListDir, target, path),
    mkdir: (target, path) => invoke(C.sshMkdir, target, path),
    serve: (target, path) => invoke(C.sshServe, target, path),
  },
  pipes: {
    onMessage(pipe, listener) {
      let set = pipeListeners.get(pipe)
      if (!set) pipeListeners.set(pipe, set = new Set())
      set.add(listener)
      const queued = early.get(pipe)
      if (queued) {
        early.delete(pipe)
        for (const message of queued) listener(message)
        if (queued.some((message) => isPipeControl(message) && message.t === 'close')) pipeListeners.delete(pipe)
      }
      return () => { set.delete(listener) }
    },
    write(pipe, bytes) {
      ports.get(pipe)?.postMessage(bytes)
    },
    open(pipe) {
      ports.get(pipe)?.postMessage({ t: 'open' } satisfies PipeMessage)
    },
    close(pipe, reason) {
      const port = ports.get(pipe)
      if (port) {
        port.postMessage({ t: 'close', ...(reason ? { reason } : {}) } satisfies PipeMessage)
        port.close()
      }
      forget(pipe)
    },
  },
  web: {
    partitionFor: (workspace) => invoke(C.webPartition, workspace),
    release: (workspace) => invoke(C.webRelease, workspace),
    setCookie: (partition, url, cookie) => invoke(C.webSetCookie, partition, url, cookie),
  },
  webgl: {
    request: (panelId) => invoke(C.webglRequest, panelId),
    release: (panelId) => ipcRenderer.send(C.webglRelease, panelId),
  },
}

contextBridge.exposeInMainWorld('cateDesktop', api)
contextBridge.exposeInMainWorld('cateBrowserPage', createBrowserPageBridge())
