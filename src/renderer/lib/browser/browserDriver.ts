// =============================================================================
// browserDriver — renderer executor for the extension `cate.browser.*` reverse
// API.
//
// The main process forwards a guest's `cate.browser.*` call to the window that
// owns the target browser panel; useCateHostActionResponder hands it here. We
// resolve WHICH browser panel the call targets, drive its live <webview> via the
// portalRegistry, and reply with a machine-readable outcome.
//
// Target resolution order (see resolveTargetPanelId):
//   1. explicit args.panelId — must be a browser panel in THIS window's store
//   2. the focused browser (active panel is a browser of this workspace)
//   3. the first browser panel in the workspace (matches terminalUrlOpen)
//
// Actions resolve a generation-scoped snapshot ref, auto-wait for an actionable
// target, then deliver real input through webContents.sendInputEvent. Refs from
// an older snapshot cannot silently address a different element.
// =============================================================================

import { useAppStore } from '../../stores/appStore'
import { getActivePanelId } from '../activePanel'
import { portalRegistry, type PortalWebview } from '../portalRegistry'
import { placementForBackgroundPanel } from '../workspace/canvasAccess'

export type BrowserOutcome = { ok: true; result?: unknown } | { ok: false; error: string }

/** First browser panel in the workspace, or null. Shared with terminalUrlOpen so
 *  both the terminal link-open path and the reverse API pick the same panel. */
export function findBrowserPanelId(workspaceId: string): string | null {
  const ws = useAppStore.getState().workspaces.find((w) => w.id === workspaceId)
  if (!ws) return null
  for (const panel of Object.values(ws.panels)) {
    if (panel.type === 'browser') return panel.id
  }
  return null
}

/** Resolve which browser panel a call targets. Returns the panelId or a stable
 *  error string. `no-browser` means the workspace has no browser panel at all
 *  (the `open` handler treats that as "create one"). */
function resolveTargetPanelId(
  workspaceId: string,
  args: Record<string, unknown>,
): { panelId: string } | { error: string } {
  const ws = useAppStore.getState().workspaces.find((w) => w.id === workspaceId)
  const explicit = typeof args.panelId === 'string' ? args.panelId : undefined
  if (explicit) {
    const panel = ws?.panels?.[explicit]
    // Mirror panel.setTitle: a panel detached into another window is absent from
    // this store, so we can't drive it here. Reject rather than lie.
    if (!panel || panel.type !== 'browser') return { error: 'panel-not-in-window' }
    return { panelId: explicit }
  }
  const active = getActivePanelId()
  if (active && ws?.panels?.[active]?.type === 'browser') return { panelId: active }
  const first = findBrowserPanelId(workspaceId)
  if (first) return { panelId: first }
  return { error: 'no-browser' }
}

/** Fetch the live <webview> for a resolved panelId, or a `webview-not-ready`
 *  outcome when it isn't registered yet (guest not dom-ready). */
function getWebview(panelId: string): { webview: PortalWebview } | { error: string } {
  const webview = portalRegistry.get(panelId)
  if (!webview) return { error: 'webview-not-ready' }
  return { webview }
}

/** A background-created browser mounts on the next React commit. Wait for its
 * portal registration before reporting `open` success so an autonomous caller
 * can immediately follow with `wait`/`snapshot` instead of racing the render. */
async function waitForWebview(panelId: string, timeoutMs = 3_000): Promise<PortalWebview | null> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const webview = portalRegistry.get(panelId)
    if (webview) return webview
    if (Date.now() >= deadline) return null
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

// --- Injected DOM scripts ----------------------------------------------------
// Never interpolate caller-supplied ref/text into the source string: pass them
// as function arguments via JSON.stringify so a malicious value can't break out
// of a string literal into executable code.

const snapshotGeneration = new WeakMap<PortalWebview, number>()

function snapshotJs(webview: PortalWebview): string {
  const generation = (snapshotGeneration.get(webview) ?? 0) + 1
  snapshotGeneration.set(webview, generation)
  const snapshotId = `s${generation}`
  return `(function (snapshotId) {
  document.querySelectorAll('[data-cate-ref]').forEach(function (el) { el.removeAttribute('data-cate-ref') })
  var sel = 'a[href],button,input,textarea,select,[role],[contenteditable],h1,h2,h3,h4,h5,h6'
  // Two passes to avoid layout thrash: a DOM write (setAttribute) invalidates
  // layout, so any getBoundingClientRect/getComputedStyle in the SAME loop would
  // force a fresh synchronous reflow per element (O(n)). Pass 1 does every layout
  // read up front; pass 2 does the writes once no more reads follow.
  // Pass 1 — read-only: keep the visible matches in document order.
  var visible = []
  Array.prototype.forEach.call(document.querySelectorAll(sel), function (el) {
    var rect = el.getBoundingClientRect()
    var style = getComputedStyle(el)
    if (rect.width <= 0 || rect.height <= 0 || style.visibility === 'hidden' || style.display === 'none') return
    visible.push(el)
  })
  // Pass 2 — write refs + build output (no layout reads here).
  var refs = []
  for (var i = 0; i < visible.length; i++) {
    var el = visible[i]
    var ref = '@' + snapshotId + 'e' + (i + 1)
    el.setAttribute('data-cate-ref', ref)
    // Bare <input> tags all read alike, so expose the type (input:search vs
    // input:submit) — it is what disambiguates a field from its submit button.
    var role = el.getAttribute('role') || el.tagName.toLowerCase()
    if (role === 'input') role = 'input:' + (el.type || 'text').toLowerCase()
    // Accessible-name fallbacks, most explicit first. An associated <label>
    // beats textContent (which is empty for inputs anyway), and a <select>'s
    // textContent is skipped — it is ALL of its options concatenated.
    var name = el.getAttribute('aria-label') || ''
    if (!name && el.labels && el.labels.length) name = el.labels[0].textContent || ''
    if (!name && el.tagName !== 'SELECT') name = el.textContent || ''
    if (!name) name = el.getAttribute('placeholder') || el.getAttribute('value') || ''
    name = name.replace(/\\s+/g, ' ').trim().slice(0, 200)
    var value = 'value' in el ? el.value : undefined
    // Never expose a password through the agent observation channel.
    if (el.tagName === 'INPUT' && String(el.type).toLowerCase() === 'password') {
      value = value ? '••••••••' : ''
    }
    var disabled = Boolean(el.disabled) || el.getAttribute('aria-disabled') === 'true'
    var inputType = el.tagName === 'INPUT' ? String(el.type).toLowerCase() : ''
    var checked = inputType === 'checkbox' || inputType === 'radio' ? Boolean(el.checked) : undefined
    var expandedAttr = el.getAttribute('aria-expanded')
    var expanded = expandedAttr === null ? undefined : expandedAttr === 'true'
    var selectedAttr = el.getAttribute('aria-selected')
    var selected = selectedAttr === null ? undefined : selectedAttr === 'true'
    var item = { ref: ref, role: role, name: name, value: value }
    if (disabled) item.disabled = true
    if (checked !== undefined) item.checked = checked
    if (expanded !== undefined) item.expanded = expanded
    if (selected !== undefined) item.selected = selected
    if (document.activeElement === el) item.focused = true
    refs.push(item)
  }
  return { snapshotId: snapshotId, url: location.href, title: document.title, refs: refs }
})(${JSON.stringify(snapshotId)})`
}

async function takeSnapshot(webview: PortalWebview): Promise<unknown> {
  return webview.executeJavaScript(snapshotJs(webview))
}

/** Canonical refs are generation-scoped `@s<n>e<n>` tokens. Legacy `@e<n>` and
 *  bare forms remain accepted as input, but new snapshots never emit them. */
function normalizeRef(raw: unknown): { ref: string } | { error: string } {
  if (typeof raw !== 'string' || raw === '') return { error: 'ref-required' }
  const ref = /^(?:s\d+)?e\d+$/.test(raw) ? `@${raw}` : raw
  if (!/^@(?:s\d+)?e\d+$/.test(ref)) return { error: 'bad-ref: expected a snapshot ref like @s12e7' }
  return { ref }
}

function elementByRefBody(): string {
  // Compare via getAttribute (not a built selector) so `ref` is never spliced
  // into a CSS query — no injection surface even though it arrives as an arg.
  return `var el = null
  var all = document.querySelectorAll('[data-cate-ref]')
  for (var i = 0; i < all.length; i++) { if (all[i].getAttribute('data-cate-ref') === ref) { el = all[i]; break } }`
}

function actionabilityJs(ref: string, mode: 'click' | 'fill'): string {
  return `(function (ref, mode) {
  ${elementByRefBody()}
  if (!el) return { error: 'stale-ref' }
  if (!el.isConnected) return { error: 'detached' }
  el.scrollIntoView({ block: 'center' })
  var rect = el.getBoundingClientRect()
  var style = getComputedStyle(el)
  if (rect.width <= 0 || rect.height <= 0 || style.visibility === 'hidden' || style.display === 'none') {
    return { error: 'not-visible' }
  }
  if (el.disabled || el.getAttribute('aria-disabled') === 'true') return { error: 'disabled' }
  if (mode === 'fill') {
    var editable = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable
    if (!editable) return { error: 'not-editable' }
    if (el.readOnly || el.getAttribute('aria-readonly') === 'true') return { error: 'readonly' }
  }
  var x = Math.max(0, Math.floor(rect.left + rect.width / 2))
  var y = Math.max(0, Math.floor(rect.top + rect.height / 2))
  var hit = document.elementFromPoint ? document.elementFromPoint(x, y) : el
  if (!hit || !(hit === el || el.contains(hit))) return { error: 'obscured' }
  return { ok: true, x: x, y: y, rect: [rect.left, rect.top, rect.width, rect.height].join(':') }
})(${JSON.stringify(ref)}, ${JSON.stringify(mode)})`
}

function focusJs(ref: string): string {
  return `(function (ref) {
  ${elementByRefBody()}
  if (!el) return { error: 'stale-ref' }
  el.scrollIntoView({ block: 'center' })
  el.focus()
  return { ok: true }
})(${JSON.stringify(ref)})`
}

function focusForFillJs(ref: string): string {
  return `(function (ref) {
  ${elementByRefBody()}
  if (!el) return { error: 'stale-ref' }
  el.scrollIntoView({ block: 'center' })
  el.focus()
  if (typeof el.select === 'function') {
    el.select()
  } else if (el.isContentEditable) {
    var selection = getSelection()
    var range = document.createRange()
    range.selectNodeContents(el)
    selection.removeAllRanges()
    selection.addRange(range)
  }
  return { ok: true }
})(${JSON.stringify(ref)})`
}

const ACTION_TIMEOUT_MS = 3_000
const ACTION_POLL_MS = 50

interface ActionablePoint { x: number; y: number }

async function waitForActionable(
  webview: PortalWebview,
  ref: string,
  mode: 'click' | 'fill',
): Promise<{ point: ActionablePoint } | { error: string }> {
  const deadline = Date.now() + ACTION_TIMEOUT_MS
  let previousRect = ''
  let lastError = 'not-actionable'
  for (;;) {
    const result = await webview.executeJavaScript(actionabilityJs(ref, mode)) as {
      ok?: true; error?: string; x?: number; y?: number; rect?: string
    }
    if (result.error === 'stale-ref') return { error: result.error }
    if (result.ok && typeof result.x === 'number' && typeof result.y === 'number') {
      if (result.rect && result.rect === previousRect) return { point: { x: result.x, y: result.y } }
      previousRect = result.rect ?? ''
      lastError = 'not-stable'
    } else {
      previousRect = ''
      lastError = result.error ?? 'not-actionable'
    }
    if (Date.now() >= deadline) return { error: `action-timeout:${lastError}` }
    await new Promise((resolve) => setTimeout(resolve, ACTION_POLL_MS))
  }
}

async function postActionOutcome(webview: PortalWebview, args: Record<string, unknown>): Promise<BrowserOutcome> {
  if (args.includeSnapshot !== true) return { ok: true }
  return {
    ok: true,
    result: {
      ok: true,
      url: webview.getURL(),
      title: webview.getTitle(),
      snapshot: await takeSnapshot(webview),
    },
  }
}

async function sendNativeFill(webview: PortalWebview, text: string): Promise<void> {
  await webview.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace' })
  await webview.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace' })
  for (const char of text) await webview.sendInputEvent({ type: 'char', keyCode: char })
}

// --- press key map -------------------------------------------------------------
// Friendly key names (lowercased) → Electron accelerator key codes for
// sendInputEvent. A closed allowlist: `press` exists to complete interaction
// flows (submit, dismiss, scroll, move), not to be a general keyboard.
const PRESS_KEYS: Record<string, string> = {
  enter: 'Return',
  return: 'Return',
  tab: 'Tab',
  escape: 'Escape',
  esc: 'Escape',
  backspace: 'Backspace',
  delete: 'Delete',
  space: 'Space',
  arrowup: 'Up',
  up: 'Up',
  arrowdown: 'Down',
  down: 'Down',
  arrowleft: 'Left',
  left: 'Left',
  arrowright: 'Right',
  right: 'Right',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  home: 'Home',
  end: 'End',
}

/** Wait for the guest to stop loading. Polls isLoading() — the PortalWebview
 *  surface has no event hooks — and must resolve WELL inside the main process's
 *  10s forward timeout, so the caller-supplied timeout is capped at 8s. */
const WAIT_DEFAULT_MS = 5_000
const WAIT_MAX_MS = 8_000
const WAIT_POLL_MS = 100

type WaitCondition =
  | { kind: 'load' }
  | { kind: 'text' | 'textGone' | 'url'; value: string }
  | { kind: 'ref'; ref: string; state: 'visible' | 'hidden' | 'attached' | 'detached' }

function waitConditionJs(condition: Exclude<WaitCondition, { kind: 'load' }>): string {
  return `(function (condition) {
    if (condition.kind === 'text' || condition.kind === 'textGone') {
      var text = document.body ? (document.body.innerText || document.body.textContent || '') : ''
      var found = text.indexOf(condition.value) !== -1
      return condition.kind === 'text' ? found : !found
    }
    if (condition.kind === 'url') {
      var escaped = condition.value.replace(/[.+?^\${}()|[\\]\\\\]/g, '\\$&').split('*').join('.*')
      return new RegExp('^' + escaped + '$').test(location.href)
    }
    var target = null
    var nodes = document.querySelectorAll('[data-cate-ref]')
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].getAttribute('data-cate-ref') === condition.ref) { target = nodes[i]; break }
    }
    var attached = Boolean(target && target.isConnected)
    var visible = false
    if (attached) {
      var rect = target.getBoundingClientRect()
      var style = getComputedStyle(target)
      visible = rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
    }
    if (condition.state === 'attached') return attached
    if (condition.state === 'detached') return !attached
    if (condition.state === 'visible') return visible
    return !visible
  })(${JSON.stringify(condition)})`
}

function parseWaitCondition(raw: unknown): WaitCondition | { error: string } {
  if (raw === undefined) return { kind: 'load' }
  if (!raw || typeof raw !== 'object') return { error: 'bad-wait-condition' }
  const value = raw as Record<string, unknown>
  if (value.kind === 'load') return { kind: 'load' }
  if ((value.kind === 'text' || value.kind === 'textGone' || value.kind === 'url') && typeof value.value === 'string') {
    return { kind: value.kind, value: value.value }
  }
  if (value.kind === 'ref' && typeof value.ref === 'string' &&
      ['visible', 'hidden', 'attached', 'detached'].includes(String(value.state))) {
    const ref = normalizeRef(value.ref)
    if ('error' in ref) return ref
    const state = value.state as 'visible' | 'hidden' | 'attached' | 'detached'
    return { kind: 'ref', ref: ref.ref, state }
  }
  return { error: 'bad-wait-condition' }
}

async function waitForCondition(
  webview: PortalWebview,
  timeoutMs: number,
  condition: WaitCondition,
  includeSnapshot: boolean,
): Promise<BrowserOutcome> {
  const deadline = Date.now() + Math.min(Math.max(timeoutMs, 0) || WAIT_DEFAULT_MS, WAIT_MAX_MS)
  for (;;) {
    const matched = condition.kind === 'load'
      ? !webview.isLoading()
      : await webview.executeJavaScript(waitConditionJs(condition)) === true
    if (matched) {
      return {
        ok: true,
        result: {
          url: webview.getURL(),
          title: webview.getTitle(),
          loading: webview.isLoading(),
          ...(includeSnapshot ? { snapshot: await takeSnapshot(webview) } : {}),
        },
      }
    }
    if (Date.now() >= deadline) {
      return { ok: false, error: condition.kind === 'load' ? 'still-loading' : `wait-timeout:${condition.kind}` }
    }
    await new Promise((r) => setTimeout(r, WAIT_POLL_MS))
  }
}

// --- Entry point -------------------------------------------------------------

/** Execute one `cate.browser.*` method. `method` keeps its full `cate.browser.`
 *  prefix (as it arrives at the responder). Always resolves (never throws). */
export async function handleBrowserMethod(
  workspaceId: string,
  method: string,
  args: Record<string, unknown>,
): Promise<BrowserOutcome> {
  const name = method.slice('cate.browser.'.length)

  // NOTE: there is deliberately no `list` here — `cate.panel.list` (the
  // responder) is the single enumeration surface and includes browser urls.

  // `open` may create a browser when none exists; resolve/handle specially.
  if (name === 'open') {
    const url = typeof args.url === 'string' ? args.url : undefined
    if (!url) return { ok: false, error: 'url-required' }
    const target = resolveTargetPanelId(workspaceId, args)
    let panelId: string
    if ('error' in target) {
      if (target.error === 'no-browser') {
        panelId = useAppStore.getState().createBrowser(
          workspaceId,
          url,
          undefined,
          placementForBackgroundPanel(workspaceId),
        )
      } else {
        return { ok: false, error: target.error }
      }
    } else {
      panelId = target.panelId
    }

    useAppStore.getState().updateBrowserActiveTabUrl(workspaceId, panelId, url)
    const webview = portalRegistry.get(panelId)
    if (webview) {
      try {
        webview.loadURL(url)
        return { ok: true, result: { panelId, url } }
      } catch {
        return { ok: false, error: 'webview-not-ready' }
      }
    }
    // No live webview: the panel was just created above, is still mounting, or
    // sits on its start page — which renders INSTEAD of a webview and would
    // never mount one on its own. The panel's registered navigator is the same
    // entry point the URL bar uses; navigating leaves the start page, which
    // mounts the webview. The loadURL after the wait covers the still-mounting
    // case, whose seeded src is the panel's OLD page (redundant but harmless
    // for the others — they mount already loading `url`).
    portalRegistry.getNavigator(panelId)?.(url)
    const mounted = await waitForWebview(panelId)
    if (!mounted) return { ok: false, error: 'webview-not-ready' }
    try {
      mounted.loadURL(url)
      return { ok: true, result: { panelId, url } }
    } catch {
      return { ok: false, error: 'webview-not-ready' }
    }
  }

  // Every remaining method needs an existing, dom-ready browser.
  const target = resolveTargetPanelId(workspaceId, args)
  if ('error' in target) return { ok: false, error: target.error }
  const found = getWebview(target.panelId)
  if ('error' in found) return { ok: false, error: found.error }
  const { webview } = found

  try {
    switch (name) {
      // No back/forward/current: agents navigate by URL (`open`) and read
      // "where am I / is it settled" from `wait`, which returns instantly when
      // the page is idle.
      case 'reload':
        webview.reload()
        return { ok: true }
      case 'screenshot': {
        const wcId = webview.getWebContentsId()
        // The CLI/agent path returns only the file path, so opt out of the
        // full-page base64 encode the UI button needs — and land in the temp
        // dir, not the user's Desktop (agents screenshot constantly).
        let result: { filePath: string } | null
        try {
          result = await window.electronAPI.webviewScreenshot(wcId, { wantDataUrl: false, saveTo: 'temp' })
        } catch {
          return { ok: false, error: 'screenshot-failed' }
        }
        if (!result) return { ok: false, error: 'screenshot-failed' }
        return { ok: true, result: { path: result.filePath } }
      }
      case 'snapshot': {
        const snap = await takeSnapshot(webview)
        return { ok: true, result: snap }
      }
      case 'click': {
        const ref = normalizeRef(args.ref)
        if ('error' in ref) return { ok: false, error: ref.error }
        const actionable = await waitForActionable(webview, ref.ref, 'click')
        if ('error' in actionable) return { ok: false, error: actionable.error }
        const { x, y } = actionable.point
        await webview.sendInputEvent({ type: 'mouseMove', x, y })
        await webview.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
        await webview.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
        return postActionOutcome(webview, args)
      }
      case 'fill':
      case 'type': {
        const ref = normalizeRef(args.ref)
        if ('error' in ref) return { ok: false, error: ref.error }
        const text = typeof args.text === 'string' ? args.text : ''
        const actionable = await waitForActionable(webview, ref.ref, 'fill')
        if ('error' in actionable) return { ok: false, error: actionable.error }
        const focused = await webview.executeJavaScript(focusForFillJs(ref.ref)) as { error?: string }
        if (focused?.error) return { ok: false, error: focused.error }
        await sendNativeFill(webview, text)
        return postActionOutcome(webview, args)
      }
      case 'wait': {
        const timeoutMs = typeof args.timeoutMs === 'number' ? args.timeoutMs : WAIT_DEFAULT_MS
        const condition = parseWaitCondition(args.condition)
        if ('error' in condition) return { ok: false, error: condition.error }
        return await waitForCondition(webview, timeoutMs, condition, args.includeSnapshot === true)
      }
      case 'press': {
        const key = typeof args.key === 'string' ? PRESS_KEYS[args.key.toLowerCase()] : undefined
        if (!key) return { ok: false, error: 'unsupported-key' }
        // Optional ref: focus the element first (Enter into a field, Tab from a
        // field). Without one the key goes to whatever the guest has focused —
        // that's how page-level keys (Escape, PageDown) work.
        if (typeof args.ref === 'string') {
          const ref = normalizeRef(args.ref)
          if ('error' in ref) return { ok: false, error: ref.error }
          const res = (await webview.executeJavaScript(focusJs(ref.ref))) as { ok?: true; error?: string }
          if (res?.error) return { ok: false, error: res.error }
        }
        // keyDown + char + keyUp is the full trusted key sequence; the char event
        // is what fires keypress/beforeinput handlers and native form submit.
        await webview.sendInputEvent({ type: 'keyDown', keyCode: key })
        if (key === 'Return' || key === 'Space' || key === 'Tab') {
          await webview.sendInputEvent({ type: 'char', keyCode: key })
        }
        await webview.sendInputEvent({ type: 'keyUp', keyCode: key })
        return postActionOutcome(webview, args)
      }
      default:
        return { ok: false, error: 'unsupported' }
    }
  } catch {
    // A live webview whose guest process just went away throws on any call.
    return { ok: false, error: 'webview-not-ready' }
  }
}
