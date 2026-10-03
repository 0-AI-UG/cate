// The mobile shell (architecture 15). The iOS app is native SwiftUI; the
// client core runs headless in a hidden web view as its core (connections,
// pairing, document mirror). Two directions cross between them:
//
// - The bridge: what the core asks the app for (native primitives only). The
//   core posts `{method, params}` to `window.webkit.messageHandlers.cate` and
//   gets a promise of the result (ios/Cate/Core/ShellBridge.swift).
// - The core API: what the app asks the core to do, through
//   `window.cateCore.call(method, paramsJson)`, answered with JSON text; and
//   the core's state, pushed to the app as one snapshot on every change.

export interface MobileAppInfo {
  /** The device's name, sent in `hello` and shown in pairing lists. */
  device: string
  /** The client features this device has (12.2): `camera` when it can scan
   *  a pairing QR code. */
  features: string[]
}

export interface MobileBridgeMethods {
  'app.info': { params: Record<string, never>; result: MobileAppInfo }
  /** A device document as JSON text, or null when it does not exist yet. */
  'device.get': { params: { name: string }; result: string | null }
  'device.set': { params: { name: string; json: string }; result: null }
  /** A secret in the Keychain (this device only), or null. */
  'keychain.get': { params: { name: string }; result: string | null }
  'keychain.set': { params: { name: string; value: string }; result: null }
  /** `host:port` addresses of the runtime advertising `runtimeId` over mDNS
   *  (`_cate._tcp`); empty when none answers within `timeoutMs`. */
  'mdns.discover': { params: { runtimeId: string; timeoutMs: number }; result: string[] }
  /** The core started and `window.cateCore` answers. */
  'core.ready': { params: Record<string, never>; result: null }
  /** The core could not start. */
  'core.failed': { params: { message: string }; result: null }
  /** The core's state changed: the whole snapshot, as JSON text. */
  'core.state': { params: { json: string }; result: null }
  /** Output for a terminal the app opened (`terminal.open`). The core waits
   *  for the reply before taking more output, so a slow view slows the PTY. */
  'terminal.event': { params: MobileTerminalEvent; result: null }
}

/** What a terminal view is told: `size` is the PTY's grid, which the view
 *  draws (before the screen, and on every change), and whether the PTY fits
 *  this view; `reset` clears the screen; `output` is bytes (base64; UTF-8 may
 *  split between chunks); `state` is the panel's PTY state as the view shows
 *  it. */
export type MobileTerminalEvent =
  | { terminalId: string; kind: 'size'; cols: number; rows: number; fitted: boolean }
  | { terminalId: string; kind: 'reset' }
  | { terminalId: string; kind: 'output'; data: string }
  | { terminalId: string; kind: 'state'; status: 'starting' | 'running' | 'exited' | 'failed'; text: string | null }

export type MobileBridgeMethod = keyof MobileBridgeMethods

export type MobileBridge = <M extends MobileBridgeMethod>(
  method: M,
  params: MobileBridgeMethods[M]['params'],
) => Promise<MobileBridgeMethods[M]['result']>

/** A connection's state as the app shows it; the wording lives here once. */
export interface MobileConnection {
  kind: 'connecting' | 'connected' | 'offline' | 'incompatible' | 'stopped' | 'refused' | 'closed'
  text: string
  /** Whether "Retry now" makes sense. */
  retryable: boolean
}

export interface MobilePanel {
  id: string
  type: string
  /** The panel type's label: Terminal, Editor, ... */
  typeLabel: string
  title: string
}

export interface MobileWorkspace {
  id: string
  name: string
  runtimeId: string
  connection: MobileConnection
  /** Null until the document arrives from the runtime. */
  panels: MobilePanel[] | null
}

export interface MobileCoreState {
  workspaces: MobileWorkspace[]
}

export type MobileJoinResult = { ok: true; workspaceId: string } | { ok: false; message: string }

export interface MobileCoreMethods {
  /** Pairs from a `cate://pair` link or a typed code and opens the workspace. */
  'workspaces.join': { params: { input: string }; result: MobileJoinResult }
  'workspaces.open': { params: { workspaceId: string }; result: null }
  'workspaces.close': { params: { workspaceId: string }; result: null }
  'workspaces.retry': { params: { workspaceId: string }; result: null }
  /** Closes it and deletes the pinned runtime key. */
  'workspaces.forget': { params: { workspaceId: string }; result: null }
  /** Shows a terminal panel in a view the app names `terminalId`: the PTY's
   *  grid, screen and live output, as `terminal.event`s, following the panel
   *  to each new PTY until `terminal.close`. `cols` x `rows` is the grid the
   *  view holds, as for every viewer: the PTY takes it while it fits this
   *  view. */
  'terminal.open': { params: { terminalId: string; workspaceId: string; panelId: string; cols: number; rows: number }; result: null }
  /** Keystrokes, exactly as typed. */
  'terminal.input': { params: { terminalId: string; data: string }; result: null }
  /** The grid the view holds changed. */
  'terminal.resize': { params: { terminalId: string; cols: number; rows: number }; result: null }
  /** Fits the PTY to this view ("Fit to phone"). */
  'terminal.fit': { params: { terminalId: string }; result: null }
  'terminal.close': { params: { terminalId: string }; result: null }
}

export type MobileCoreMethod = keyof MobileCoreMethods
