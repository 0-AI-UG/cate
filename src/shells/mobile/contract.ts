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

import type { PowerState, KeepAwakeDuration } from '@runtime/power/contract'
import type { PushStatus } from '@runtime/push/contract'
import type { AgentConversationMessage, AgentId, AgentRunner, AgentStatus, AgentTypeInfo } from '@services/agents/contract'
import type { T3Conversation, T3ProviderModels } from '@services/t3/contract'

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
  /** An event for a view the app opened (`panel.open`, `buffer.open`): a
   *  `MobileViewEvent` as JSON text. */
  'view.event': { params: { viewId: string; json: string }; result: null }
  /** Bytes or the end of a stream the app opened (`stream.open`). The core
   *  waits for the reply before sending more. */
  'stream.event': { params: MobileStreamEvent; result: null }
  /** Opens a URL outside the app (the system browser). */
  'app.openUrl': { params: { url: string }; result: null }
  /** A notification event from a connected workspace (architecture 10.5).
   *  The app decides how to show it; `id` is the one a push about the same
   *  panel carries (`pushCollapseId`), so one replaces the other. */
  'notification.show': { params: MobileNotification; result: null }
  /** The agent went back to work: what it asked for is answered. */
  'notification.withdraw': { params: { id: string }; result: null }
}

export interface MobileNotification {
  id: string
  workspaceId: string
  panelId: string | null
  /** The event's kind: `agent.needsInput`, `agent.needsPermission`,
   *  `cate.ui.notify`, ... */
  kind: string
  title: string
  body: string
}

/** What a view the app opened is told, as JSON text (`view.event`). */
export type MobileViewEvent =
  /** `panel.open`: the panel's session snapshot, whole, on every change. */
  | { kind: 'snapshot'; snapshot: unknown }
  /** `browser.*`: load `url` in the tab's page: the session moved it
   *  elsewhere (another client, an agent, the address bar). */
  | { kind: 'load'; tabId: string; url: string }
  /** `chat.*`: run `script` in the page. */
  | { kind: 'script'; script: string }
  /** `buffer.open`: the buffer's whole text, once synced and on every change
   *  not made by this view. */
  | { kind: 'text'; text: string }
  /** `buffer.open`: the buffer could not be opened or its stream ended. */
  | { kind: 'error'; message: string }
  /** `agents.watch`: the agent's state (null while the panel hosts none),
   *  the prompt sent from this chat that the conversation does not show yet,
   *  and the messages from index `from` on, which replace the app's. */
  | {
    kind: 'conversation'
    status: AgentStatus | null
    canReceivePrompt: boolean
    pending: string | null
    from: number
    messages: AgentConversationMessage[]
  }

/** A loopback stream (`stream.open`): bytes from the runtime's machine
 *  (base64), or its end. */
export type MobileStreamEvent =
  | { streamId: string; kind: 'data'; data: string }
  | { streamId: string; kind: 'end' }

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
  /** The panel type's icon name (`IconName`). */
  icon: string
  title: string
  /** The canvas the panel sits on; null for a panel in a window dock. */
  onCanvas: string | null
  /** Canvas panels: the canvas they show. */
  canvas: MobileCanvas | null
}

export interface MobileCanvasNode {
  id: string
  rect: { x: number; y: number; width: number; height: number }
  /** The panels of the node's mini dock, in tree order. */
  panels: string[]
}

export interface MobileCanvas {
  id: string
  /** In creation order. */
  nodes: MobileCanvasNode[]
}

/** An agent a panel hosts, as the agents home and the session show it. */
export interface MobileAgent {
  panelId: string
  /** The hosting panel's type: `terminal` or `chat`. */
  panelType: string
  title: string
  agentId: AgentId | null
  /** Null until the agent is known. */
  agentName: string | null
  runner: AgentRunner
  status: AgentStatus
  present: boolean
  canReceivePrompt: boolean
  /** What the agent asked for while it waits on the person, else null. */
  attention: string | null
  /** When the status last changed, epoch ms (as this device saw it). */
  since: number
  /** The checkout the agent works in; null for the workspace root. */
  checkout: string | null
}

export interface MobileWorkspace {
  id: string
  name: string
  runtimeId: string
  connection: MobileConnection
  /** Null until the document arrives from the runtime. */
  panels: MobilePanel[] | null
  /** Empty while not connected. */
  agents: MobileAgent[]
  /** Keep-awake on the runtime's machine; null while not connected. */
  power: PowerState | null
  /** This device's pushes from the workspace; null while not connected or
   *  before the app gave the core a push token. */
  push: PushStatus | null
}

export interface MobileCoreState {
  /** This client's id: browser sessions name it as the source of its own
   *  navigations and tab selections. */
  clientId: string
  workspaces: MobileWorkspace[]
}

/** The answer to an agent or git action: ok, or what went wrong in words. */
export type MobileActionResult = { ok: true } | { ok: false; message: string }

/** An agent CLI a new agent can run, as the composer offers it
 *  (`cate.agent.types`). */
export type MobileAgentChoice = AgentTypeInfo

/** Where a new agent runs: a terminal running its CLI, or a T3 chat on a
 *  provider instance and model. */
export type MobileAgentLaunch =
  | { runner: 'terminal'; agentId: AgentId }
  | { runner: 't3'; instanceId: string; model: string }

/** Where a new panel goes: on the canvas a canvas panel shows, centred on
 *  `point` (canvas coordinates) or, without one, where there is room. A
 *  create without a placement goes to the dock. */
export interface MobilePlacement {
  canvasPanelId: string
  point?: { x: number; y: number }
}

export type MobileJoinResult = { ok: true; workspaceId: string } | { ok: false; message: string }

export interface MobileCoreMethods {
  /** Pairs from a `cate://pair` link or a typed code and opens the workspace. */
  'workspaces.join': { params: { input: string }; result: MobileJoinResult }
  'workspaces.open': { params: { workspaceId: string }; result: null }
  'workspaces.close': { params: { workspaceId: string }; result: null }
  /** Stops the workspace's runtime for everyone (`runtime.stop`), then closes it. */
  'workspaces.stop': { params: { workspaceId: string }; result: null }
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

  /** Follows a panel's session in a view the app names `viewId`: its
   *  snapshot as `snapshot` events until `panel.close`. */
  'panel.open': { params: { viewId: string; workspaceId: string; panelId: string }; result: null }
  /** Runs one op on the view's session (the panel type's op JSON). */
  'panel.op': { params: { viewId: string; op: unknown }; result: MobileOpResult }
  'panel.close': { params: { viewId: string }; result: null }
  /** The panel types people can create, in creation order. */
  'panel.creatable': { params: { workspaceId: string }; result: MobilePanelChoice[] }
  /** Creates a panel of `type` at `placement` (the dock without one);
   *  answers with its id, or null. */
  'panel.create': { params: { workspaceId: string; type: string; placement?: MobilePlacement }; result: string | null }
  /** Closes a panel (`closePanel`; a canvas takes the panels on it); true
   *  once the op went. */
  'panel.remove': { params: { workspaceId: string; panelId: string }; result: boolean }
  /** The panel types a surface can become where it sits. */
  'surface.choices': { params: { workspaceId: string; panelId: string }; result: MobilePanelChoice[] }
  /** Turns a surface into `type`, in place. */
  'surface.pick': { params: { workspaceId: string; panelId: string; type: string }; result: boolean }

  /** Shows a file's shared buffer in a view the app names `viewId`: its text
   *  as `text` events until `buffer.close`. */
  'buffer.open': { params: { viewId: string; workspaceId: string; path: string }; result: null }
  /** Replaces `length` UTF-16 units at `from` with `text`; answers with the
   *  whole text after the edit, which includes edits made elsewhere. */
  'buffer.edit': { params: { viewId: string; from: number; length: number; text: string }; result: { text: string } }
  'buffer.close': { params: { viewId: string }; result: null }
  /** A folder's entries on the runtime's machine, folders first. */
  'files.list': { params: { workspaceId: string; path: string }; result: MobileFileEntry[] }
  /** A URL the workspace's web views load for a workspace file. */
  'files.url': { params: { workspaceId: string; path: string }; result: string }

  /** A browser panel's view: `panel.open`, and the view follows the session
   *  (`load` events) and reports what its pages do. */
  'browser.open': { params: { viewId: string; workspaceId: string; panelId: string }; result: null }
  'browser.navigated': { params: { viewId: string; tabId: string; url: string; title: string; inPage: boolean; canGoBack: boolean; canGoForward: boolean }; result: null }
  'browser.loading': { params: { viewId: string; tabId: string; loading: boolean; loadError: string | null }; result: null }
  'browser.title': { params: { viewId: string; tabId: string; title: string }; result: null }

  /** A chat panel's view: `panel.open`, and the page's binding (`script`
   *  events). */
  'chat.open': { params: { viewId: string; workspaceId: string; panelId: string }; result: null }
  /** The page of the snapshot's `loadId`; null until the harness is ready. */
  'chat.page': { params: { viewId: string; dark: boolean }; result: MobileChatPage | null }
  /** Whether the page may go to `url` (`committed`: it already did, in page;
   *  a refused one is moved back with a `script` event). */
  'chat.navigation': { params: { viewId: string; url: string; committed: boolean }; result: { allow: boolean } }
  /** A bridge request the page logged; answers with the script that replies. */
  'chat.hostMessage': { params: { viewId: string; message: string }; result: string | null }
  /** The conversations of the panel's checkout, latest first. Selecting one
   *  is the `selectThread` op, renaming the current one `renameConversation`. */
  'chat.conversations': { params: { viewId: string }; result: T3Conversation[] }

  /** Follows a panel's agent conversation as `conversation` events for
   *  `viewId` until `agents.unwatch`; `pending` is a first prompt on its way. */
  'agents.watch': { params: { viewId: string; workspaceId: string; panelId: string; pending?: string }; result: null }
  'agents.unwatch': { params: { viewId: string }; result: null }
  /** Sends a prompt from the chat `viewId` follows: pending there until the
   *  conversation has it. */
  'agents.send': { params: { viewId: string; workspaceId: string; panelId: string; prompt: string }; result: MobileActionResult }
  /** Stops the agent's turn (Esc, Ctrl-C, T3's stop); the agent stays. */
  'agents.interrupt': { params: { workspaceId: string; panelId: string }; result: MobileActionResult }
  /** Every agent CLI, in registry order. */
  'agents.choices': { params: { workspaceId: string }; result: MobileAgentChoice[] }
  /** The T3 provider instances a new chat can run on, with their models,
   *  from T3's last provider probe. Starts no T3 harness. */
  'agents.t3Models': { params: { workspaceId: string }; result: T3ProviderModels[] }
  /** Starts an agent on `prompt`; `worktree` runs it in a new worktree named
   *  after the prompt, `placement` puts its panel on a canvas. Answers with
   *  the panel that hosts it. */
  'agents.start': {
    params: { workspaceId: string; prompt: string; launch: MobileAgentLaunch; worktree: boolean; placement?: MobilePlacement }
    result: { ok: true; panelId: string } | { ok: false; message: string }
  }
  /** Shows the changes of the agent a panel hosts in a review panel filtered
   *  to it (reusing a review of its checkout); the review's id, or null. */
  'agents.review': { params: { workspaceId: string; panelId: string }; result: string | null }

  /** Keeps the runtime's machine awake for a while (`power.set`). */
  'power.set': { params: { workspaceId: string; duration: KeepAwakeDuration }; result: MobileActionResult }
  /** Where this device's pushes go and the key they are sealed with
   *  (`push.register`): the core registers them with every workspace it
   *  connects to. */
  'push.device': { params: { target: string; key: string }; result: null }
  /** Turns the workspace's network access to Cate Connect, which pushes go
   *  through. */
  'push.useCateConnect': { params: { workspaceId: string }; result: MobileActionResult }

  /** Loopback routing (12.3) for the workspace's web views. WebKit never
   *  proxies loopback hosts, so the app listens on this phone's loopback at
   *  the runtime port a page needs and forwards each connection. The port to
   *  forward before loading `url`: null when its host is not loopback. */
  'loopback.port': { params: { url: string }; result: number | null }
  /** A byte stream to `port` on the runtime's machine, for one forwarded
   *  connection. */
  'stream.open': { params: { streamId: string; workspaceId: string; port: number }; result: null }
  'stream.write': { params: { streamId: string; data: string }; result: null }
  'stream.close': { params: { streamId: string }; result: null }
}

export type MobileOpResult = { ok: true; result: unknown } | { ok: false; message: string; code: string | null }

export interface MobilePanelChoice {
  type: string
  label: string
  icon: string
  /** It can be placed on a canvas. */
  canvas: boolean
}

export interface MobileFileEntry {
  name: string
  path: string
  isDirectory: boolean
}

/** The chat page of one load: where to load it, the cookie to install first,
 *  and what to run in it. */
export interface MobileChatPage {
  loadId: number
  url: string
  origin: string
  cookie: { name: string; value: string }
  /** Run at document end of every page load. */
  script: string
  css: string
}

export type MobileCoreMethod = keyof MobileCoreMethods
