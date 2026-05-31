// =============================================================================
// Concrete executors for cate-control actions. Each takes (params, ctx, agentKey)
// and returns a CateControlResponse. Pure-ish: side effects go through appStore /
// canvasStore / terminalRegistry. Geometry comes from cateControlLayout.
//
// The agent addresses panels by a short id - the first 6 chars of the panel's
// UUID (e.g. "a1b2c3"), which cate_layout reports and resolvePanelRef() resolves
// back to the full panelId by prefix. The full UUID and an exact title are
// accepted as fallbacks. The short id is stable across restarts because the
// panel keeps its UUID on restore. 'self' refers to the agent's own host panel.
// =============================================================================

import type { CateControlResponse } from '../../shared/cateControl'
import type { CateControlContext, CateExecutor } from './cateControl'
import { useAppStore } from '../../renderer/stores/appStore'
import { PANEL_DEFINITIONS } from '../../shared/panels'
import type { PanelType } from '../../shared/types'
import { computePlacement, type Rect } from '../../renderer/lib/cateControlLayout'
import { openFileAsPanel } from '../../renderer/lib/fileRouting'
import { setPendingReveal } from '../../renderer/lib/editorReveal'
import { terminalRegistry } from '../../renderer/lib/terminalRegistry'
import { portalRegistry, type PortalWebview } from '../../renderer/lib/portalRegistry'
import { setCateExecutors } from './cateControl'

/** Cap on text returned to the agent from read/eval (keeps tool results small). */
const MAX_BROWSER_TEXT = 30000

const OPENABLE: PanelType[] = ['editor', 'terminal', 'browser', 'document']

function fail(error: string): CateControlResponse { return { ok: false, error } }
function ok(result?: unknown): CateControlResponse { return { ok: true, result } }

/** The panels of the executor's workspace, keyed by panelId. */
function workspacePanels(ctx: CateControlContext): Record<string, { type?: string; title?: string }> {
  const ws = useAppStore.getState().workspaces.find((w: any) => w.id === ctx.workspaceId)
  return (ws?.panels ?? {}) as Record<string, { type?: string; title?: string }>
}

/** Human title for a panelId (falls back to the id if the panel is gone). */
function titleFor(ctx: CateControlContext, panelId: string): string {
  return workspacePanels(ctx)[panelId]?.title || panelId
}

/** SHORT_ID_LEN chars of a panel's UUID — the stable handle the agent targets.
 *  Long enough that a collision within one workspace is astronomically unlikely;
 *  resolvePanelRef still errors loudly if two panels ever share a prefix. */
const SHORT_ID_LEN = 6
function shortId(panelId: string): string {
  return panelId.slice(0, SHORT_ID_LEN)
}

/** Resolve a panel reference - the short id (e.g. "a1b2c3"), or 'self' for the
 *  agent's host panel - to its full panelId. The full UUID and an exact title
 *  are accepted as fallbacks. The short id is the canonical, stable way to
 *  target a panel (titles track the page/file and change underfoot). */
function resolvePanelRef(ctx: CateControlContext, ref: unknown): { panelId?: string; error?: string } {
  const s = String(ref ?? '').trim()
  if (!s) return { error: 'missing `panel` (expected a panel id like "a1b2c3").' }
  if (s === 'self') return { panelId: ctx.hostPanelId }
  const panels = workspacePanels(ctx)
  // Exact full UUID.
  if (panels[s]) return { panelId: s }
  // Primary: the short id (a UUID prefix). Error if it's ambiguous so the agent
  // retries with a longer prefix instead of acting on the wrong panel.
  const byPrefix = Object.keys(panels).filter((id) => id.startsWith(s))
  if (byPrefix.length === 1) return { panelId: byPrefix[0] }
  if (byPrefix.length > 1) return { error: `"${s}" matches ${byPrefix.length} panels - use a longer id prefix (call cate_layout for the full ids).` }
  // Fallback: an exact (but possibly stale/ambiguous) title.
  const byTitle = Object.keys(panels).filter((id) => panels[id]?.title === s)
  if (byTitle.length === 1) return { panelId: byTitle[0] }
  if (byTitle.length === 0) return { error: `No panel with id "${s}" - call cate_layout to list panel ids.` }
  return { error: `"${s}" matches several panels by title - target it by id (e.g. "a1b2c3") instead.` }
}

/** Read occupied rects + viewport center from a context's canvas store. */
function readCanvasGeometry(ctx: CateControlContext): { occupied: Rect[]; viewportCenter: { x: number; y: number }; nodesByPanel: Map<string, { nodeId: string; rect: Rect }> } {
  const st = ctx.canvasStore.getState()
  const occupied: Rect[] = []
  const nodesByPanel = new Map<string, { nodeId: string; rect: Rect }>()
  for (const node of Object.values(st.nodes)) {
    const rect: Rect = { x: node.origin.x, y: node.origin.y, width: node.size.width, height: node.size.height }
    occupied.push(rect)
    nodesByPanel.set(node.panelId, { nodeId: node.id, rect })
  }
  // Real viewport center in canvas-space: map the center of the canvas container
  // through the current zoom/offset. This is what the user is actually looking at,
  // so new panels land in view (the old centroid-of-all-nodes estimate could drop
  // a panel far off-screen). Fall back to the node centroid only when the canvas
  // container hasn't been measured yet (headless / pre-mount / tests).
  const cs = st.containerSize
  let center: { x: number; y: number }
  if (cs.width > 0 && cs.height > 0) {
    center = st.viewToCanvas({ x: cs.width / 2, y: cs.height / 2 })
  } else if (occupied.length) {
    center = { x: occupied.reduce((s, r) => s + r.x + r.width / 2, 0) / occupied.length, y: occupied.reduce((s, r) => s + r.y + r.height / 2, 0) / occupied.length }
  } else {
    center = { x: 0, y: 0 }
  }
  return { occupied, viewportCenter: center, nodesByPanel }
}

/** Resolve a placement's `relativeTo` (a title or 'self') to a node rect. */
function relativeRect(ctx: CateControlContext, placement: Record<string, unknown>, nodesByPanel: Map<string, { rect: Rect }>): Rect | undefined {
  if (placement.relativeTo == null) return undefined
  const relPanelId = resolvePanelRef(ctx, placement.relativeTo).panelId
  return relPanelId ? nodesByPanel.get(relPanelId)?.rect : undefined
}

/** Run a node-creating action while keeping the camera fixed. Every app.create*()
 *  routes through addNodeAndFocus, which focus-AND-centers the new node - i.e. it
 *  pans/zooms the user's view. The agent must never move the camera, so we
 *  snapshot the viewport, run the creator, then restore it. */
function withCameraPreserved<T>(ctx: CateControlContext, create: () => T): T {
  const s = ctx.canvasStore.getState()
  const cam = { zoom: s.zoomLevel, offset: { ...s.viewportOffset } }
  const out = create()
  ctx.canvasStore.getState().setZoomAndOffset(cam.zoom, cam.offset)
  return out
}

/** Move a freshly-created node into view: to an explicit semantic placement if
 *  given, else the current viewport center. Never moves the camera. addNode's
 *  default drops the node near the focused node, which may be off-screen. */
function placeNewNode(
  ctx: CateControlContext,
  panelId: string,
  fallbackType: PanelType,
  placement: Record<string, unknown> = {},
): void {
  const node = ctx.canvasStore.getState().nodeForPanel(panelId)
  if (!node) return
  const { occupied, viewportCenter, nodesByPanel } = readCanvasGeometry(ctx)
  const size = ctx.canvasStore.getState().nodes[node]?.size ?? PANEL_DEFINITIONS[fallbackType].defaultSize
  const relativeTo = relativeRect(ctx, placement, nodesByPanel)
  // Exclude the freshly-created node from its own obstacle set (by identity).
  const selfRect = nodesByPanel.get(panelId)?.rect
  const obstacles = selfRect ? occupied.filter((r) => r !== selfRect) : occupied
  const rect = computePlacement({ size, relativeTo, position: placement.position as any, occupied: obstacles, viewportCenter })
  ctx.canvasStore.getState().moveNode(node, { x: rect.x, y: rect.y })
}

/** Send `command` to a terminal panel's PTY, waiting for the PTY to spawn.
 *  A freshly-created terminal needs panel mount + async node-pty spawn before
 *  terminalRegistry has its ptyId, so a single fixed delay is unreliable - poll
 *  until ready (or time out). Returns true once the command was written.
 *  (`appStore.createTerminal`'s `initialInput` arg is intentionally not persisted
 *  to PanelState - it would re-run on session restore - so it can't be used here.) */
async function writeToTerminalWhenReady(panelId: string, command: string, timeoutMs = 6000): Promise<boolean> {
  const data = command.endsWith('\r') || command.endsWith('\n') ? command : command + '\r'
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const ptyId = terminalRegistry.getEntry(panelId)?.ptyId
    if (ptyId) { window.electronAPI.terminalWrite(ptyId, data); return true }
    if (Date.now() >= deadline) return false
    await new Promise((r) => setTimeout(r, 100))
  }
}

// ---------------------------------------------------------------------------
// layout - read the canvas
// ---------------------------------------------------------------------------

/** Report the open panels by title/type so the agent can target them. */
export const execGetLayout: CateExecutor = async (_params, ctx) => {
  const panels = workspacePanels(ctx)
  const st = ctx.canvasStore.getState()
  const out = Object.values(st.nodes).map((node: any) => {
    const panel = panels[node.panelId]
    return {
      id: shortId(node.panelId),
      title: panel?.title ?? '',
      type: panel?.type ?? 'unknown',
      focused: st.focusedNodeId === node.id,
      isSelf: node.panelId === ctx.hostPanelId,
    }
  })
  return ok({ panels: out })
}

// ---------------------------------------------------------------------------
// panel - open / close / move
// ---------------------------------------------------------------------------

export const execOpenPanel: CateExecutor = async (params, ctx) => {
  const type = String(params.type ?? '') as PanelType
  if (!OPENABLE.includes(type)) return fail(`Unsupported panel type: ${String(params.type)}`)
  const target = (params.target ?? {}) as Record<string, unknown>
  const app = useAppStore.getState()
  const wsId = ctx.workspaceId

  // A terminal `command` is run after the panel mounts (see below) - NOT passed
  // as createTerminal's `initialInput`, which the store drops.
  let pendingTerminalCommand: string | undefined
  // create*() pans/zooms to the new node; keep the camera fixed (see helper).
  const panelId = withCameraPreserved(ctx, () => {
    switch (type) {
      case 'editor': {
        const path = typeof target.path === 'string' ? target.path : undefined
        const id = path ? openFileAsPanel(wsId, path) : app.createEditor(wsId)
        if (path && (typeof target.line === 'number')) {
          setPendingReveal(id, { line: target.line as number, column: typeof target.column === 'number' ? (target.column as number) : undefined })
        }
        // Convenience: open straight into rendered markdown preview (markdown files only).
        if (target.preview === true) {
          app.setPanelMarkdownPreview(wsId, id, true)
        }
        return id
      }
      case 'terminal': {
        const id = app.createTerminal(wsId, undefined, undefined, undefined, typeof target.cwd === 'string' ? target.cwd : undefined)
        pendingTerminalCommand = typeof target.command === 'string' && target.command.trim() ? target.command : undefined
        return id
      }
      case 'browser':
        return app.createBrowser(wsId, typeof target.url === 'string' ? target.url : undefined)
      case 'document':
        return typeof target.path === 'string' ? openFileAsPanel(wsId, target.path) : app.createEditor(wsId)
      default:
        return ''
    }
  })
  if (!panelId) return fail(`Unsupported panel type: ${String(params.type)}`)

  // Place the new node into view (explicit placement or viewport center) without
  // moving the camera.
  placeNewNode(ctx, panelId, type, (params.placement ?? {}) as Record<string, unknown>)

  // Run the requested command once the freshly-created terminal's PTY is live.
  if (pendingTerminalCommand) {
    await writeToTerminalWhenReady(panelId, pendingTerminalCommand)
  }

  // Raise + focus the freshly opened panel, but never move the camera.
  const node = ctx.canvasStore.getState().nodeForPanel(panelId)
  if (node) ctx.canvasStore.getState().focusNode(node)
  return ok({ id: shortId(panelId), title: titleFor(ctx, panelId), type })
}

export const execClosePanel: CateExecutor = async (params, ctx) => {
  const ref = resolvePanelRef(ctx, params.panel)
  if (ref.error) return fail(ref.error)
  const panelId = ref.panelId!
  if (panelId === ctx.hostPanelId) return fail('Refusing to close the agent panel hosting this chat.')
  const title = titleFor(ctx, panelId)
  useAppStore.getState().closePanel(ctx.workspaceId, panelId)
  return ok({ closed: title })
}

export const execMovePanel: CateExecutor = async (params, ctx) => {
  const ref = resolvePanelRef(ctx, params.panel)
  if (ref.error) return fail(ref.error)
  const panelId = ref.panelId!
  if (panelId === ctx.hostPanelId) return fail('Refusing to move the agent panel hosting this chat.')
  const node = ctx.canvasStore.getState().nodeForPanel(panelId)
  if (!node) return fail(`Panel "${titleFor(ctx, panelId)}" is not on the canvas.`)
  const { occupied, viewportCenter, nodesByPanel } = readCanvasGeometry(ctx)
  const st = ctx.canvasStore.getState()
  const size = st.nodes[node].size
  const placement = (params.placement ?? {}) as Record<string, unknown>
  const relativeTo = relativeRect(ctx, placement, nodesByPanel)
  // Exclude the node being moved from its own obstacle set (by identity).
  const selfRect = nodesByPanel.get(panelId)?.rect
  const obstacles = selfRect ? occupied.filter((r) => r !== selfRect) : occupied
  const rect = computePlacement({ size, relativeTo, position: placement.position as any, occupied: obstacles, viewportCenter })
  st.moveNode(node, { x: rect.x, y: rect.y })
  return ok({ moved: titleFor(ctx, panelId) })
}

// ---------------------------------------------------------------------------
// browser - control an existing browser panel (opening is the `panel` tool's job)
// ---------------------------------------------------------------------------

/** Resolve a panel ref to its live <webview>. The panel must be a browser and
 *  have mounted (registered its guest in portalRegistry). */
function resolveBrowser(
  ctx: CateControlContext,
  ref: unknown,
): { webview?: PortalWebview; panelId?: string; title?: string; error?: string } {
  const r = resolvePanelRef(ctx, ref)
  if (r.error) return { error: r.error }
  const panelId = r.panelId!
  const type = workspacePanels(ctx)[panelId]?.type
  if (type && type !== 'browser') return { error: `Panel "${titleFor(ctx, panelId)}" is not a browser panel.` }
  const webview = portalRegistry.get(panelId)
  if (!webview) return { error: `Browser "${titleFor(ctx, panelId)}" is not ready (no live web view).` }
  return { webview, panelId, title: titleFor(ctx, panelId) }
}

function truncate(text: string): { text: string; truncated?: true } {
  if (text.length <= MAX_BROWSER_TEXT) return { text }
  return { text: text.slice(0, MAX_BROWSER_TEXT), truncated: true }
}

/** navigate - point an existing browser panel at a url. */
export const execBrowserNavigate: CateExecutor = async (params, ctx) => {
  const url = String(params.url ?? '')
  if (!/^(https?|file):\/\//i.test(url)) return fail('browser navigate requires an http(s) or file URL.')
  const b = resolveBrowser(ctx, params.panel)
  if (b.error) return fail(b.error)
  await b.webview!.loadURL(url)
  // Persist so a session restore reopens the panel on this url (the webview's
  // own did-navigate also persists, but loadURL is async - do it eagerly too).
  useAppStore.getState().updatePanelUrl(ctx.workspaceId, b.panelId!, url)
  return ok({ browser: b.title, url })
}

/** back / forward / reload / stop - history + loading control. */
export const execBrowserHistory: CateExecutor = async (params, ctx) => {
  const op = String(params.op ?? '')
  const b = resolveBrowser(ctx, params.panel)
  if (b.error) return fail(b.error)
  const wv = b.webview!
  switch (op) {
    case 'back':
      if (!wv.canGoBack()) return fail(`Browser "${b.title}" cannot go back.`)
      wv.goBack(); break
    case 'forward':
      if (!wv.canGoForward()) return fail(`Browser "${b.title}" cannot go forward.`)
      wv.goForward(); break
    case 'reload': wv.reload(); break
    case 'stop': wv.stop(); break
    default: return fail(`browser: unknown history op "${op}".`)
  }
  return ok({ browser: b.title, op })
}

/** info - report the current navigation state (read-only). */
export const execBrowserInfo: CateExecutor = async (params, ctx) => {
  const b = resolveBrowser(ctx, params.panel)
  if (b.error) return fail(b.error)
  const wv = b.webview!
  return ok({
    browser: b.title,
    url: wv.getURL(),
    title: wv.getTitle(),
    canGoBack: wv.canGoBack(),
    canGoForward: wv.canGoForward(),
  })
}

/** read - the page's visible text, or one CSS selector's text (read-only). */
export const execBrowserRead: CateExecutor = async (params, ctx) => {
  const b = resolveBrowser(ctx, params.panel)
  if (b.error) return fail(b.error)
  const selector = typeof params.selector === 'string' ? params.selector.trim() : ''
  const code = selector
    ? `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? el.innerText : null })()`
    : `document.body ? document.body.innerText : ''`
  const raw = await b.webview!.executeJavaScript(code)
  if (selector && raw == null) return fail(`No element matches selector "${selector}".`)
  const { text, truncated } = truncate(String(raw ?? ''))
  return ok({ browser: b.title, url: b.webview!.getURL(), ...(selector ? { selector } : {}), text, ...(truncated ? { truncated } : {}) })
}

/** eval - run arbitrary JavaScript in the page and return its result. */
export const execBrowserEval: CateExecutor = async (params, ctx) => {
  const js = String(params.js ?? '')
  if (!js.trim()) return fail('browser eval requires `js` (JavaScript to run in the page).')
  const b = resolveBrowser(ctx, params.panel)
  if (b.error) return fail(b.error)
  const raw = await b.webview!.executeJavaScript(js, true)
  let result: string | undefined
  if (raw !== undefined) {
    let serialized: string
    try { serialized = typeof raw === 'string' ? raw : JSON.stringify(raw) } catch { serialized = String(raw) }
    result = truncate(serialized ?? String(raw)).text
  }
  return ok({ browser: b.title, result })
}

/** screenshot - capture the page to an image file (reuses the main-process path). */
export const execBrowserScreenshot: CateExecutor = async (params, ctx) => {
  const b = resolveBrowser(ctx, params.panel)
  if (b.error) return fail(b.error)
  const wcId = b.webview!.getWebContentsId()
  const shot = await window.electronAPI.webviewScreenshot(wcId)
  if (!shot?.filePath) return fail(`Screenshot of "${b.title}" failed.`)
  return ok({ browser: b.title, filePath: shot.filePath })
}

// ---------------------------------------------------------------------------
// terminal - run / read
// ---------------------------------------------------------------------------

export const execRunInTerminal: CateExecutor = async (params, ctx) => {
  const command = String(params.command ?? '')
  if (!command.trim()) return fail('terminal run requires a non-empty command.')
  const app = useAppStore.getState()
  let panelId = ''
  if (params.panel != null && !params.newPanel) {
    const ref = resolvePanelRef(ctx, params.panel)
    if (ref.error) return fail(ref.error)
    panelId = ref.panelId!
  }
  if (!panelId) {
    panelId = withCameraPreserved(ctx, () => app.createTerminal(ctx.workspaceId))
    placeNewNode(ctx, panelId, 'terminal')
  }
  const sent = await writeToTerminalWhenReady(panelId, command)
  if (!sent) return fail(`Terminal "${titleFor(ctx, panelId)}" did not become ready to receive input (timed out).`)
  return ok({ id: shortId(panelId), terminal: titleFor(ctx, panelId), command })
}

/** Read the recent buffer (visible screen + scrollback) of a terminal panel as
 *  plain text. Lets an agent inspect command output it ran via terminal run.
 *  Reads straight from the live xterm buffer; no PTY round-trip. Safe (read-only). */
export const execReadTerminal: CateExecutor = async (params, ctx) => {
  const ref = resolvePanelRef(ctx, params.panel)
  if (ref.error) return fail(ref.error)
  const panelId = ref.panelId!
  const entry = terminalRegistry.getEntry(panelId)
  const buffer = (entry as { terminal?: { buffer?: { active?: any } } } | undefined)?.terminal?.buffer?.active
  if (!entry || !buffer) return fail(`No live terminal for "${titleFor(ctx, panelId)}".`)

  const requested = typeof params.lines === 'number' ? Math.floor(params.lines) : 50
  const maxLines = Math.max(1, Math.min(requested, 1000))
  const total: number = buffer.length ?? 0
  const start = Math.max(0, total - maxLines)
  const collected: string[] = []
  for (let i = start; i < total; i++) {
    const line = buffer.getLine(i)
    collected.push(line ? line.translateToString(true) : '')
  }
  // Drop trailing blank rows (an idle terminal pads the screen with empties).
  while (collected.length && collected[collected.length - 1] === '') collected.pop()
  return ok({ terminal: titleFor(ctx, panelId), lineCount: collected.length, text: collected.join('\n') })
}

// ---------------------------------------------------------------------------
// Op-routers - the agent sees four tools (layout / panel / browser / terminal);
// each dispatches to the focused executors above by `op`.
// ---------------------------------------------------------------------------

/** Single-panel lifecycle/geometry. */
export const execPanel: CateExecutor = async (params, ctx, agentKey) => {
  const op = String(params.op ?? '')
  switch (op) {
    case 'open': return execOpenPanel(params, ctx, agentKey)
    case 'close': return execClosePanel(params, ctx, agentKey)
    case 'move': return execMovePanel(params, ctx, agentKey)
    default:
      return fail(`panel: unknown op "${op}". Expected open|close|move.`)
  }
}

/** Browser control: drive an existing browser panel (opening is the panel tool). */
export const execBrowser: CateExecutor = async (params, ctx, agentKey) => {
  const op = String(params.op ?? '')
  switch (op) {
    case 'navigate': return execBrowserNavigate(params, ctx, agentKey)
    case 'back':
    case 'forward':
    case 'reload':
    case 'stop': return execBrowserHistory(params, ctx, agentKey)
    case 'info': return execBrowserInfo(params, ctx, agentKey)
    case 'read': return execBrowserRead(params, ctx, agentKey)
    case 'eval': return execBrowserEval(params, ctx, agentKey)
    case 'screenshot': return execBrowserScreenshot(params, ctx, agentKey)
    default:
      return fail(`browser: unknown op "${op}". Expected navigate|back|forward|reload|stop|info|read|eval|screenshot.`)
  }
}

export const execTerminal: CateExecutor = async (params, ctx, agentKey) => {
  const op = String(params.op ?? '')
  switch (op) {
    case 'run': return execRunInTerminal(params, ctx, agentKey)
    case 'read': return execReadTerminal(params, ctx, agentKey)
    default:
      return fail(`terminal: unknown op "${op}". Expected run|read.`)
  }
}

// Register the 4-tool surface with the dispatcher.
setCateExecutors({
  layout: execGetLayout,
  panel: execPanel,
  browser: execBrowser,
  terminal: execTerminal,
})
