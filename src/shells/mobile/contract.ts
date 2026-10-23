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
import type { AgentId, AgentStatus, AgentStep, AgentTypeInfo } from '@services/agents/contract'
import type { RelationKind } from '@workspace/document/contract'
import type { Point } from '@workspace/canvas/contract'
import type { RelationContextMode } from '@workspace/relations/contract'

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
  /** A notification event from a connected workspace (architecture 10.4).
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
   *  `runtime.warning` */
  kind: string
  title: string
  body: string
}

/** What a view the app opened is told, as JSON text (`view.event`). */
/** One step of a text change, in UTF-16 units, applied in order from the
 *  start: keep `retain` units, insert `insert`, or remove `delete` units. */
export type MobileTextDelta = { retain: number } | { insert: string } | { delete: number }

export type MobileViewEvent =
  /** `panel.open`: the panel's session snapshot, whole, on every change. */
  | { kind: 'snapshot'; snapshot: unknown }
  /** `browser.*`: load `url` in the tab's page: the session moved it
   *  elsewhere (another client, an agent, the address bar). */
  | { kind: 'load'; tabId: string; url: string }
  /** `buffer.open`: the buffer's whole text once synced, at `version` (one
   *  more for every change of the buffer, wherever it was made). */
  | { kind: 'text'; text: string; version: number }
  /** `buffer.open`: a change not made by this view, taking the buffer from
   *  version `from` to `to`. */
  | { kind: 'change'; from: number; to: number; delta: MobileTextDelta[] }
  /** `buffer.open`: the buffer could not be opened or its stream ended. */
  | { kind: 'error'; message: string }
  /** `agents.watch`: the chat (`MobileChat`) with its items from index
   *  `from` on, which replace the app's from there; the items before stay. */
  | ({ kind: 'chat'; from: number } & MobileChat)

/** A loopback stream (`stream.open`): bytes from the runtime's machine
 *  (base64), or its end. */
export type MobileStreamEvent =
  | { streamId: string; kind: 'data'; data: string }
  | { streamId: string; kind: 'end' }

/** What a terminal view is told: `size` is the PTY's grid, which the view
 *  draws (before the screen, and on every change); `reset` clears the screen; `output` is bytes (base64; UTF-8 may
 *  split between chunks); `state` is the panel's PTY state as the view shows
 *  it. */
export type MobileTerminalEvent =
  | { terminalId: string; kind: 'size'; cols: number; rows: number }
  | { terminalId: string; kind: 'reset' }
  | { terminalId: string; kind: 'output'; data: string }
  | { terminalId: string; kind: 'state'; status: 'starting' | 'running' | 'exited' | 'failed'; text: string | null }

export type MobileBridgeMethod = keyof MobileBridgeMethods

export type MobileBridge = <M extends MobileBridgeMethod>(
  method: M,
  params: MobileBridgeMethods[M]['params'],
) => Promise<MobileBridgeMethods[M]['result']>

/** What the app offers for a connection state: try again
 *  (`workspaces.retry`), pair again (the join sheet), or forget the
 *  workspace (`workspaces.forget`, the core's `close` remedy). */
export type MobileConnectionAction = 'retry' | 'pair' | 'forget'

/** A connection's state as the app shows it; the wording lives here once
 *  (`connectionStatus` in the client core). */
export interface MobileConnection {
  kind: 'connecting' | 'connected' | 'offline' | 'incompatible' | 'stopped' | 'refused' | 'closed'
  /** A short heading; empty when connected or closed. */
  title: string
  text: string
  /** Main action first. */
  actions: MobileConnectionAction[]
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
  /** It takes prompts (a terminal): its relations go with them as
   *  context. */
  execution: boolean
  /** When its prompts take its relations' context (9.7). */
  contextMode: RelationContextMode
  /** What it shows, in a few words (its type's `describe`): a terminal's
   *  directory, an editor's file, a browser's URL; null when its type says
   *  nothing. */
  detail: string | null
  /** The checkout it belongs to (one of its workspace's `worktrees`); null
   *  when it is in none or the workspace has no parallel checkouts. */
  worktreeId: string | null
  /** It can be moved to another checkout (`panel.setWorktree`). */
  switchesWorktree: boolean
}

/** A checkout of the workspace's repository, as the app shows it. */
export interface MobileWorktree {
  id: string
  /** Its label, else its folder's name; the main checkout is `main`. */
  label: string
  /** A theme palette key (`green`, `brightCyan`, ...): its territory on a
   *  canvas and its mark on a panel. */
  color: string
  isPrimary: boolean
}

/** An agent a review can hand its work to. */
export interface MobileReviewAgent {
  agentId: AgentId
  name: string
  /** Its CLI is installed where the review runs. */
  ready: boolean
}

/** A relation between two panels (9.7), as the app shows it. */
export interface MobileRelation {
  id: string
  fromPanelId: string
  toPanelId: string
  kind: RelationKind
  /** Its flow (`relationFlows`), which picks its color; null when no
   *  execution surface reaches it. */
  flow: number | null
  /** Its words for its pair: its own label, else the kind's ("Reference",
   *  "Send findings to"). */
  label: string
  /** Its own label, which stands in for its kind's words; null without. */
  custom: string | null
  /** How it is drawn on the canvas both its panels sit on; null when they
   *  are on none together, or share a node. */
  curve: MobileRelationCurve | null
  /** The meanings it can take, the recommended one first. */
  options: MobileRelationOption[]
}

/** A relation's curve (`panelConnectionCurve`, exactly as the desktop draws
 *  it), in canvas units: from `start` through cubic segments, its chip at
 *  `midpoint`. While a node is dragged the app bends the curve along with it
 *  until the document has the node's new place. */
export interface MobileRelationCurve {
  canvasId: string
  fromNodeId: string
  toNodeId: string
  start: Point
  segments: Array<{ c1: Point; c2: Point; end: Point }>
  midpoint: Point
}

/** A meaning a new relation can take, the recommended one first. */
export interface MobileRelationOption {
  kind: RelationKind
  label: string
  description: string
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
  /** The hosting panel's type. */
  panelType: string
  title: string
  agentId: AgentId | null
  /** Null until the agent is known. */
  agentName: string | null
  /** The agent whose logo marks its panel, as on the desktop's tabs: a CLI
   *  standing in for its terminal while it runs; null shows the panel's
   *  own icon. */
  logo: AgentId | null
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
  /** Its ready checkouts, the main one first; empty unless there are two or
   *  more (one checkout is no parallel branch). */
  worktrees: MobileWorktree[]
  /** Empty while not connected or while relations are off. */
  relations: MobileRelation[]
  /** The workspace setting `panelRelationsEnabled`. */
  relationsEnabled: boolean
  /** Empty while not connected. */
  agents: MobileAgent[]
  /** Keep-awake on the runtime's machine; null while not connected. */
  power: PowerState | null
  /** This device's pushes from the workspace; null while not connected or
   *  before the app gave the core a push token. */
  push: PushStatus | null
  /** The other clients in the workspace (presence); empty while not connected. */
  others: MobileOtherClient[]
}

/** Another client in a workspace, as the app shows it. */
export interface MobileOtherClient {
  clientId: string
  /** Its device's name. */
  name: string
  /** It has its person's attention. */
  attentive: boolean
}

export interface MobileCoreState {
  /** This client's id: browser sessions name it as the source of its own
   *  navigations and tab selections. */
  clientId: string
  workspaces: MobileWorkspace[]
  /** A workspace that must be trusted before it runs anything (9.2); the app
   *  asks and answers `workspaces.answerTrust`. Null when nothing asks. */
  trustPrompt: { workspaceId: string; label: string } | null
  /** This device's library of custom relation labels, reused across
   *  workspaces (`savedPanelRelationLabels`). */
  savedRelationLabels: string[]
}

/** The answer to an agent or git action: ok, or what went wrong in words. */
export type MobileActionResult = { ok: true } | { ok: false; message: string }

/** The answer to `panel.setWorktree`: `dirty` when the panel is busy and
 *  switching would stop what runs; the app asks, then sends `discard`. */
export type MobileSwitchResult = MobileActionResult | { ok: false; message: string; dirty: true }

/** An agent chat as the app shows it (`chatTimeline.ts`). */
export interface MobileChat {
  /** The conversation was read: false while it is on its way. */
  loaded: boolean
  /** The agent's state; null while the panel hosts no agent. */
  status: AgentStatus | null
  canReceivePrompt: boolean
  /** A prompt waiting for the agent to be at its prompt. */
  queued: string | null
  /** The turn in progress, from the prompt going out until the agent ended
   *  it, with the step it last completed; null between turns. */
  turn: { step: AgentStep | null } | null
  items: MobileChatItem[]
}

/** A chat's item. Ids stay while the chat grows: a message's is its place,
 *  a step group's the message it shows before. */
export type MobileChatItem =
  /** The person's prompt; `sent` false while the conversation does not
   *  show it yet. */
  | { kind: 'prompt'; id: string; text: string; sent: boolean }
  | { kind: 'reply'; id: string; text: string }
  /** Steps the agent took; a ghost stands for steps from before the runtime
   *  kept them. */
  | { kind: 'steps'; id: string; steps: AgentStep[]; ghost: boolean }

/** A file a search found (`search.files`). */
export interface MobileFileMatch {
  name: string
  /** Absolute, on the runtime's machine. */
  path: string
  /** Relative to the searched folder. */
  relativePath: string
  isDirectory: boolean
}

/** An agent CLI a new agent can run, as the composer offers it
 *  (`cate.agent.types`). */
export type MobileAgentChoice = AgentTypeInfo

/** Where a new panel goes: on the canvas a canvas panel shows, exactly at
 *  `spot` (a planned one, `canvas.plan`), else centred near `point` (canvas
 *  coordinates) at its type's default size, else where there is room. A
 *  create without a placement goes to the dock. */
export interface MobilePlacement {
  canvasPanelId: string
  point?: { x: number; y: number }
  spot?: MobileCanvasRect
}

/** How a new panel gets its spot (`planPlacement`): straight to `place`, or
 *  the person picks one of `pick`, best first. */
export type MobilePlacementPlan = { place: MobileCanvasRect } | { pick: MobileCanvasRect[] }

/** A rect in canvas coordinates: its top-left and size. */
export interface MobileCanvasRect {
  x: number
  y: number
  width: number
  height: number
}

export type MobileJoinResult = { ok: true; workspaceId: string } | { ok: false; message: string }

export interface MobileCoreMethods {
  /** Pairs from a `cate://pair` link or a typed code and opens the workspace. */
  /** The app came to the front or went away (its scene phase): a client in
   *  front shows no notifications when `notifyOnlyWhenUnfocused` is on. */
  'app.setActive': { params: { active: boolean }; result: null }
  'workspaces.join': { params: { input: string }; result: MobileJoinResult }
  'workspaces.open': { params: { workspaceId: string }; result: null }
  /** The person's answer to `trustPrompt`. */
  'workspaces.answerTrust': { params: { trusted: boolean }; result: { ok: boolean; message?: string } }
  /** Disconnects; the workspace stays in the list. */
  'workspaces.close': { params: { workspaceId: string }; result: null }
  /** Stops the workspace's runtime for everyone (`runtime.stop`), then closes it. */
  'workspaces.stop': { params: { workspaceId: string }; result: null }
  'workspaces.retry': { params: { workspaceId: string }; result: null }
  /** Disconnects it and drops it from the list, deleting its pinned
   *  runtime key: opening it again takes a new code. */
  'workspaces.forget': { params: { workspaceId: string }; result: null }
  /** Shows a terminal panel in a view the app names `terminalId`: the PTY's
   *  grid, screen and live output, as `terminal.event`s, following the panel
   *  to each new PTY until `terminal.close`. */
  'terminal.open': { params: { terminalId: string; workspaceId: string; panelId: string }; result: null }
  /** Keystrokes, exactly as typed. */
  'terminal.input': { params: { terminalId: string; data: string }; result: null }
  /** Sizes the PTY to `cols` x `rows`, the grid the view holds, so it shows
   *  it whole. The PTY's size changes only through a fit (from any client). */
  'terminal.fit': { params: { terminalId: string; cols: number; rows: number }; result: null }
  'terminal.close': { params: { terminalId: string }; result: null }
  /** A link the person tapped in the terminal (an OSC 8 hyperlink's URI): a
   *  file opens in Cate, a web URL outside the app, except a loopback one,
   *  which only Cate reaches. */
  'terminal.openLink': { params: { terminalId: string; uri: string }; result: null }

  /** Follows a panel's session in a view the app names `viewId`: its
   *  snapshot as `snapshot` events until `panel.close`. */
  'panel.open': { params: { viewId: string; workspaceId: string; panelId: string }; result: null }
  /** Runs one op on the view's session (the panel type's op JSON). */
  'panel.op': { params: { viewId: string; op: unknown }; result: MobileOpResult }
  'panel.close': { params: { viewId: string }; result: null }
  /** Opens the sessions of panels the person is likely to open next (the
   *  first few of `panelIds`), so their views start with a snapshot; each
   *  stays open for a while (`SESSION_LINGER_MS`). */
  'panel.warm': { params: { workspaceId: string; panelIds: string[] }; result: null }
  /** The panel types people can create, in creation order. */
  'panel.creatable': { params: { workspaceId: string }; result: MobilePanelChoice[] }
  /** Creates a panel of `type` at `placement` (the dock without one);
   *  answers with its id, or null. */
  'panel.create': { params: { workspaceId: string; type: string; placement?: MobilePlacement }; result: string | null }
  /** Closes a panel (`closePanel`; a canvas takes the panels on it); true
   *  once the op went. */
  'panel.remove': { params: { workspaceId: string; panelId: string }; result: boolean }
  /** Moves a panel to the checkout `worktreeId` (a `switchesWorktree`
   *  panel); `discard` stops what runs in it. */
  'panel.setWorktree': { params: { workspaceId: string; panelId: string; worktreeId: string; discard?: boolean }; result: MobileSwitchResult }
  /** The panel types a surface can become where it sits. */
  'surface.choices': { params: { workspaceId: string; panelId: string }; result: MobilePanelChoice[] }
  /** Turns a surface into `type`, in place. */
  'surface.pick': { params: { workspaceId: string; panelId: string; type: string }; result: boolean }

  /** Shows a file's shared buffer in a view the app names `viewId`: its text
   *  as `text` events until `buffer.close`. */
  'buffer.open': { params: { viewId: string; workspaceId: string; path: string }; result: null }
  /** Replaces `length` UTF-16 units at `from` with `text`; answers with the
   *  buffer's version after the edit (one more than before unless changes
   *  made elsewhere came between). */
  'buffer.edit': { params: { viewId: string; from: number; length: number; text: string }; result: { version: number } }
  /** The buffer's whole text and its version. */
  'buffer.text': { params: { viewId: string }; result: { text: string; version: number } }
  'buffer.close': { params: { viewId: string }; result: null }
  /** Starts syncing a text file's buffer before its view opens it (an
   *  editor opening while its session's snapshot is on its way); held for a
   *  few seconds. Documents (images, PDFs) are skipped. */
  'buffer.warm': { params: { workspaceId: string; path: string }; result: null }
  /** A folder's entries on the runtime's machine, folders first. */
  'files.list': { params: { workspaceId: string; path: string }; result: MobileFileEntry[] }
  /** Files whose names match `query`, under `root` (the workspace root when
   *  omitted), best first. */
  'files.search': { params: { workspaceId: string; query: string; root?: string }; result: MobileFileMatch[] }
  /** A URL the workspace's web views load for a workspace file. */
  'files.url': { params: { workspaceId: string; path: string }; result: string }

  /** A browser panel's view: `panel.open`, and the view follows the session
   *  (`load` events) and reports what its pages do. */
  'browser.open': { params: { viewId: string; workspaceId: string; panelId: string }; result: null }
  'browser.navigated': { params: { viewId: string; tabId: string; url: string; title: string; inPage: boolean; canGoBack: boolean; canGoForward: boolean }; result: null }
  'browser.loading': { params: { viewId: string; tabId: string; loading: boolean; loadError: string | null }; result: null }
  'browser.title': { params: { viewId: string; tabId: string; title: string }; result: null }

  /** Follows a panel's agent conversation as `conversation` events for
   *  `viewId` until `agents.unwatch`; `pending` is a first prompt on its way. */
  'agents.watch': { params: { viewId: string; workspaceId: string; panelId: string; pending?: string }; result: null }
  'agents.unwatch': { params: { viewId: string }; result: null }
  /** Sends a prompt from the view `viewId` follows: pending there until the
   *  conversation has it. */
  'agents.send': { params: { viewId: string; workspaceId: string; panelId: string; prompt: string }; result: MobileActionResult }
  /** Sends a prompt from the view `viewId` follows once the agent can take
   *  it (replacing one queued there). */
  'agents.queue': { params: { viewId: string; prompt: string }; result: null }
  /** Takes the view's queued prompt back; null when none waits. */
  'agents.unqueue': { params: { viewId: string }; result: string | null }
  /** Stores a photo (`image`) or another file in the workspace's data on the
   *  runtime's machine, for a prompt to name; `data` is base64. Answers with
   *  its path there. */
  'agents.attach': {
    params: { workspaceId: string; name: string; kind: 'image' | 'file'; data: string }
    result: { ok: true; path: string } | { ok: false; message: string }
  }
  /** Stops the agent's turn (Esc, Ctrl-C); the agent stays. */
  'agents.interrupt': { params: { workspaceId: string; panelId: string }; result: MobileActionResult }
  /** Every agent CLI, in registry order. */
  'agents.choices': { params: { workspaceId: string }; result: MobileAgentChoice[] }
  /** Starts agent CLI `agentId` on `prompt` in a new terminal; `worktree`
   *  runs it in a new worktree named after the prompt, `placement` puts its
   *  panel on a canvas. Answers with the panel that hosts it. */
  'agents.start': {
    params: { workspaceId: string; prompt: string; agentId: AgentId; worktree: boolean; placement?: MobilePlacement }
    result: { ok: true; panelId: string } | { ok: false; message: string }
  }
  /** Shows the changes of the agent a panel hosts in a review panel filtered
   *  to it (reusing a review of its checkout); the review's id, or null. */
  'agents.review': { params: { workspaceId: string; panelId: string }; result: string | null }

  /** The panels `panelId` can connect to (none that would close a cycle). */
  'relations.targets': { params: { workspaceId: string; panelId: string }; result: string[] }
  /** The meanings a relation from `fromPanelId` to `toPanelId` can take. */
  'relations.options': { params: { workspaceId: string; fromPanelId: string; toPanelId: string }; result: MobileRelationOption[] }
  /** Connects two panels, or gives their relation a new meaning; false when
   *  the op failed. */
  'relations.connect': { params: { workspaceId: string; fromPanelId: string; toPanelId: string; kind: RelationKind }; result: boolean }
  /** Gives a relation another meaning, dropping its own label. */
  'relations.setKind': { params: { workspaceId: string; relationId: string; kind: RelationKind }; result: boolean }
  /** Gives a relation words of its own, its kind kept; `remember` puts them
   *  first in the library (new words, not a saved label picked). */
  'relations.setLabel': { params: { workspaceId: string; relationId: string; label: string; remember: boolean }; result: boolean }
  /** Renames a saved label in the library. */
  'relations.renameLabel': { params: { label: string; to: string }; result: null }
  /** Removes a saved label from the library; relations keep theirs. */
  'relations.forgetLabel': { params: { label: string }; result: null }
  'relations.remove': { params: { workspaceId: string; relationId: string }; result: boolean }
  /** When the panel's prompts take its relations' context. */
  'relations.setContextMode': { params: { workspaceId: string; panelId: string; mode: RelationContextMode }; result: boolean }
  /** The context the panel's next prompt would take, as the runtime would
   *  send it; null when none would go. */
  'relations.preview': { params: { workspaceId: string; panelId: string }; result: string | null }

  /** A review view's agents that can review or take its findings, by name
   *  (`reviewAgents`). */
  'review.agents': { params: { viewId: string }; result: MobileReviewAgent[] }
  /** The review's notes as Markdown, as the desktop copies them. */
  'review.notes': { params: { viewId: string }; result: string }
  /** Opens a changed file in a new editor panel next to the review; its id,
   *  or null. */
  'review.openFile': { params: { viewId: string; path: string }; result: string | null }
  /** A changed image's versions, base64; null for a file that is no image. */
  'review.images': {
    params: { viewId: string; path: string; oldPath?: string }
    result: { mime: string; old: string | null; new: string | null } | null
  }

  /** Moves a canvas node to `origin` (canvas coordinates), keeping its
   *  size; false when the op failed. */
  'canvas.moveNode': { params: { workspaceId: string; canvasId: string; nodeId: string; origin: { x: number; y: number } }; result: boolean }
  /** Where a new panel of `type` goes on the canvas a canvas panel shows,
   *  planned as on every client (`planPlacement`) for the part of it on
   *  screen (`visible`, empty when nothing is drawn). Null without that
   *  canvas. */
  'canvas.plan': {
    params: { workspaceId: string; canvasPanelId: string; type: string; visible: MobileCanvasRect }
    result: MobilePlacementPlan | null
  }

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

export type MobileCoreMethod = keyof MobileCoreMethods
