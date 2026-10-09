// What the desktop preload exposes to the renderer as `window.cateDesktop`.
// Desktop IPC only: windows, device files, dialogs and OS actions, menus, the
// updater, capture, the drag ghost, raw pipes for the client's transports and
// the web partitions. No workspace work crosses it.

import type { ClientFeature, DeviceInfo } from '@kernel/rpc/contract'
import type { DeviceStore } from '@kernel/state/contract'
import type { ActionId, ContextMenuItem } from '@kernel/interaction/contract'
import type { MenuModel } from './menu'
import type { FileRef } from '@workspace/files/contract'
import type { Machine, MachineSetup } from '@runtime/daemon/contract'
import type { PipeMessage } from './pipe'

export type DesktopWindowKind = 'main' | 'detached'

export interface DesktopAppInfo {
  version: string
  platform: string
  arch: string
  isPackaged: boolean
  e2e: boolean
  /** The features to send in `hello` (12.2). */
  features: ClientFeature[]
  /** This device, for `hello`: its name and key fingerprint. */
  device: DeviceInfo
  /** The window asking. A detached window renders one document window. */
  window: { kind: DesktopWindowKind; workspaceId?: string; windowId?: string }
}

export interface Bounds { x: number; y: number; width: number; height: number }

/** A detached window of a workspace document (`DocWindow` id). */
export interface DetachedWindowRef { workspaceId: string; windowId: string }

export interface WindowState { fullscreen: boolean; maximized: boolean; focused: boolean }

/** Commands that need Electron, scoped to the calling window. */
export type NativeAction =
  | 'newWindow'
  | 'closeWindow'
  | 'showMainWindow'
  | 'toggleFullscreen'
  | 'reloadWindow'
  | 'toggleDevTools'
  | 'documentation'
  | 'reportIssue'

export interface MessageBoxRequest {
  type?: 'none' | 'info' | 'error' | 'question' | 'warning'
  message: string
  detail?: string
  buttons: string[]
  defaultId?: number
  cancelId?: number
}

export interface OpenDialogRequest {
  title?: string
  directory?: boolean
  multiple?: boolean
  filters?: { name: string; extensions: string[] }[]
  defaultPath?: string
}

export interface NotificationRequest {
  title: string
  body: string
  /** Echoed back on `onNotificationAction` when the notification is clicked. */
  action?: unknown
}

export type UpdateState = 'idle' | 'disabled' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'up-to-date' | 'error'

export interface UpdateStatus {
  state: UpdateState
  version: string | null
  percent?: number
  message?: string
  /** This status answers an explicit check. */
  manual?: boolean
  /** Re-open the "update ready" dialog even if it was dismissed for this version. */
  forceShow?: boolean
}

export interface RecentScreenshot {
  id: string
  /** A small thumbnail data URL. */
  thumbnail: string
  /** An annotated copy, stored in a workspace: read and dragged through it. */
  ref?: FileRef
}

/** A panel drag that may leave its window (the drag ghost follows it). */
export interface DragPayload {
  workspaceId: string
  panelId: string
  title: string
  /** An inline `<svg>` icon, or empty. */
  iconSvg?: string
  size?: { width: number; height: number }
}

export interface DragPointer {
  dragId: string
  payload: DragPayload
  /** Screen coordinates. */
  x: number
  y: number
}

/** A paired runtime to dial (structurally `NetworkTarget` of client/connections). */
export interface DesktopNetworkTarget {
  runtimeId: string
  endpoints: readonly ({ kind: 'lan'; address: string; port: number } | { kind: 'connect' })[]
}

export interface PairResult {
  runtimeId: string
  /** Where to reach the runtime; stored with the paired workspace. */
  endpoints: DesktopNetworkTarget['endpoints'][number][]
  /** The runtime's static key, pinned in known-runtimes. */
  publicKey: Uint8Array
}

export interface LoopbackRequest {
  runtimeId: string
  port: number
  /** The pipe to answer on: `pipes.open` after dialing, or `pipes.close(reason)`. */
  pipe: string
}

export interface AppPerfSnapshot {
  sampledAt: number
  windowMs: number
  focused: boolean
  totalCpu: number
  procs: { type: string; pid: number; cpu: number; memMB: number }[]
}

export interface DesktopPipes {
  /** Delivered in order; messages that arrive before the first listener are kept. */
  onMessage(pipe: string, listener: (message: PipeMessage) => void): () => void
  write(pipe: string, bytes: Uint8Array): void
  /** A loopback pipe the renderer dialed for main. */
  open(pipe: string): void
  close(pipe: string, reason?: string): void
}

export interface DesktopApi {
  app: {
    info(): Promise<DesktopAppInfo>
    /** Blocks quitting while client-local work runs (a file drop importing).
     *  Empty clears this window's blockers. */
    setQuitBlockers(labels: string[]): void
    /** A path opened with the app (Finder, dock, argv): add and open it as a
     *  local workspace. Delivered once the renderer called `openRequestsReady`. */
    onOpenPath(listener: (path: string) => void): () => void
    onOpenUrl(listener: (url: string) => void): () => void
    openRequestsReady(): void
    perf(): Promise<AppPerfSnapshot | null>
    /** The app gained (a window of it took OS focus) or lost the person's
     *  attention. Assume attention until told otherwise. */
    onAttention(listener: (attentive: boolean) => void): () => void
  }
  /** `settings`, `ui-state`, `boot`, `workspaces`, `known-runtimes`. */
  device: DeviceStore
  windows: {
    /** Opens (or focuses) the native window for a detached document window,
     *  where this device last had it, else at `bounds`, else where the OS
     *  puts a new window. */
    open(ref: DetachedWindowRef & { bounds?: Bounds }): Promise<void>
    close(ref: DetachedWindowRef): Promise<void>
    focus(ref: DetachedWindowRef): Promise<void>
    list(): Promise<DetachedWindowRef[]>
  }
  /** The calling window. */
  window: {
    newMainWindow(): Promise<void>
    minimize(): Promise<void>
    toggleMaximize(): Promise<void>
    close(): Promise<void>
    setTitle(title: string): Promise<void>
    state(): Promise<WindowState>
    onState(listener: (state: WindowState) => void): () => void
    /** The user closed this detached window: the renderer applies the
     *  document op; the window closes when its document window goes. */
    onCloseRequested(listener: () => void): () => void
    /** Synchronous: any app window in native fullscreen (refuse detaching). */
    anyFullscreen(): boolean
    /** This window's zoom factor (the `uiScale` setting). Scales Cate's own
     *  chrome; webview guests keep their own zoom. */
    setZoomFactor(factor: number): void
  }
  menu: {
    showContextMenu(items: ContextMenuItem[]): Promise<string | null>
    barItems(): Promise<string[]>
    popupBarItem(index: number, x: number, y: number): Promise<void>
    runNativeAction(action: NativeAction): Promise<void>
    /** Replaces the native menu bar (and the keys it answers). */
    setModel(model: MenuModel): Promise<void>
    /** A menu pick or a key forwarded from a web page: an action to run. */
    onAction(listener: (action: ActionId) => void): () => void
  }
  dialogs: {
    messageBox(request: MessageBoxRequest): Promise<number>
    open(request: OpenDialogRequest): Promise<string[] | null>
    /** Picks an image and copies it into `canvas-backgrounds/`; the managed path. */
    pickCanvasBackground(): Promise<string | null>
    readCanvasBackground(path: string): Promise<string | null>
    pruneCanvasBackgrounds(keepPath: string): Promise<void>
  }
  os: {
    openExternal(url: string): Promise<void>
    /** Opens the device `settings.json` (client settings) in the OS. */
    openSettingsFile(): Promise<void>
    writeClipboard(text: string): Promise<void>
    readClipboard(): Promise<string>
    notify(notification: NotificationRequest): Promise<void>
    onNotificationAction(listener: (action: unknown) => void): () => void
  }
  updates: {
    status(): Promise<UpdateStatus>
    check(): Promise<void>
    /** Quit and install a downloaded update. False when none is staged. */
    install(): Promise<boolean>
    onStatus(listener: (status: UpdateStatus) => void): () => void
  }
  analytics: {
    track(feature: string, props?: Record<string, string | number | boolean>): void
    feedbackPending(): Promise<{ fromVersion: string; toVersion: string } | null>
    submitFeedback(feedback: { rating: number; comment: string }): Promise<{ ok: boolean; buffered?: boolean }>
    dismissFeedback(): void
    onFeedbackPrompt(listener: (prompt: { fromVersion: string; toVersion: string }) => void): () => void
  }
  capture: {
    /** This window as PNG bytes; `rect` in window CSS pixels. */
    window(rect?: Bounds): Promise<Uint8Array | null>
    recentScreenshots(): Promise<RecentScreenshot[]>
    onRecentScreenshots(listener: (shots: RecentScreenshot[]) => void): () => void
    /** A recent OS screenshot as PNG bytes. */
    readRecentScreenshot(id: string): Promise<Uint8Array>
    dragRecentScreenshot(id: string): Promise<void>
    /** Adds an annotated copy (PNG bytes, stored at `ref`) to every window's stack. */
    addAnnotatedScreenshot(ref: FileRef, png: Uint8Array): Promise<RecentScreenshot>
  }
  drag: {
    /** Starts the ghost and the cross-window pointer; the drag id. */
    start(payload: DragPayload): Promise<string | null>
    /** A window under the pointer takes the drop; the payload, or null. */
    claim(dragId: string): Promise<DragPayload | null>
    /** The source released: whether another window claimed it. */
    end(dragId: string): Promise<{ claimed: boolean }>
    cancel(dragId: string): Promise<void>
    onPointer(listener: (pointer: DragPointer) => void): () => void
    onEnded(listener: (dragId: string) => void): () => void
  }
  transports: {
    /** Pipe ids; bytes flow through `pipes`. */
    dialLocal(root: string): Promise<string>
    dialMachine(machine: Machine, root: string): Promise<string>
    dialNetwork(target: DesktopNetworkTarget): Promise<string>
    dialLoopbackTcp(port: number): Promise<string>
    /** Pairs with a runtime from a `cate://pair` link or a typed code. */
    pair(request: { link: string; deviceName?: string }): Promise<PairResult>
    /** Main's loopback web proxy needs a pipe to a port of a runtime's machine. */
    onLoopbackRequest(listener: (request: LoopbackRequest) => void): () => void
  }
  /** Setting up a runtime on a machine this device runs commands on (the
   *  system `ssh`, `wsl.exe`). */
  machines: MachineSetup
  pipes: DesktopPipes
  web: {
    /** The workspace's browser partition, routed through its loopback web
     *  proxy. This window then serves the proxy's loopback requests. */
    partitionFor(workspace: { runtimeId: string }): Promise<string>
    release(workspace: { runtimeId: string }): Promise<void>
    /** Sets a cookie for a loopback `url` in a prepared workspace partition
     *  (T3's session cookie before its page loads). */
    setCookie(partition: string, url: string, cookie: { name: string; value: string }): Promise<void>
  }
  webgl: {
    request(panelId: string): Promise<boolean>
    release(panelId: string): void
  }
}
