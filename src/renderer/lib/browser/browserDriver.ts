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
// SECURITY / FIDELITY NOTE: click/type synthesise DOM events (Event with
// isTrusted=false). Pages that gate on trusted events (some drag/paste flows,
// certain <input type=file> pickers) won't react. This is an accepted v1
// limitation — documented so callers don't treat a synthetic click as a full
// user gesture.
// =============================================================================

import { useAppStore } from '../../stores/appStore'
import { getActivePanelId } from '../activePanel'
import { portalRegistry, type PortalWebview } from '../portalRegistry'
import { isStartPageUrl } from '../../../shared/types'

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

// --- Injected DOM scripts ----------------------------------------------------
// Never interpolate caller-supplied ref/text into the source string: pass them
// as function arguments via JSON.stringify so a malicious value can't break out
// of a string literal into executable code.

const SNAPSHOT_JS = `(function () {
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
    var ref = '@e' + (i + 1)
    el.setAttribute('data-cate-ref', ref)
    var role = el.getAttribute('role') || el.tagName.toLowerCase()
    var name = (el.getAttribute('aria-label') || el.textContent || el.getAttribute('placeholder') || el.getAttribute('value') || '').trim().slice(0, 200)
    var value = 'value' in el ? el.value : undefined
    refs.push({ ref: ref, role: role, name: name, value: value })
  }
  return { url: location.href, title: document.title, refs: refs }
})()`

function elementByRefBody(): string {
  // Compare via getAttribute (not a built selector) so `ref` is never spliced
  // into a CSS query — no injection surface even though it arrives as an arg.
  return `var el = null
  var all = document.querySelectorAll('[data-cate-ref]')
  for (var i = 0; i < all.length; i++) { if (all[i].getAttribute('data-cate-ref') === ref) { el = all[i]; break } }`
}

function clickJs(ref: string): string {
  return `(function (ref) {
  ${elementByRefBody()}
  if (!el) return { error: 'stale-ref' }
  el.scrollIntoView({ block: 'center' })
  el.focus()
  el.click()
  return { ok: true }
})(${JSON.stringify(ref)})`
}

function typeJs(ref: string, text: string): string {
  return `(function (ref, text) {
  ${elementByRefBody()}
  if (!el) return { error: 'stale-ref' }
  el.scrollIntoView({ block: 'center' })
  el.focus()
  if ('value' in el) { el.value = text } else { el.textContent = text }
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
  return { ok: true }
})(${JSON.stringify(ref)}, ${JSON.stringify(text)})`
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

  // `list` reads the store only — no webview needed, works even mid-load.
  if (name === 'list') {
    const ws = useAppStore.getState().workspaces.find((w) => w.id === workspaceId)
    const active = getActivePanelId()
    const browsers = Object.values(ws?.panels ?? {})
      .filter((p) => p.type === 'browser')
      .map((p) => ({
        panelId: p.id,
        title: p.title,
        url: isStartPageUrl(p.url) ? '' : (p.url ?? ''),
        focused: p.id === active,
      }))
    return { ok: true, result: browsers }
  }

  // `open` may create a browser when none exists; resolve/handle specially.
  if (name === 'open') {
    const url = typeof args.url === 'string' ? args.url : undefined
    if (!url) return { ok: false, error: 'url-required' }
    const target = resolveTargetPanelId(workspaceId, args)
    if ('error' in target) {
      if (target.error === 'no-browser') {
        const panelId = useAppStore.getState().createBrowser(workspaceId, url)
        return { ok: true, result: { panelId, url } }
      }
      return { ok: false, error: target.error }
    }
    const webview = portalRegistry.get(target.panelId)
    // Mirror terminalUrlOpen: if the webview isn't attached yet, still update the
    // stored URL so the panel navigates there on mount — a real success.
    if (!webview) {
      useAppStore.getState().updatePanelUrl(workspaceId, target.panelId, url)
      return { ok: true, result: { panelId: target.panelId, url } }
    }
    try {
      webview.loadURL(url)
      useAppStore.getState().updatePanelUrl(workspaceId, target.panelId, url)
      return { ok: true, result: { panelId: target.panelId, url } }
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
      case 'back':
        if (!webview.canGoBack()) return { ok: false, error: 'cannot-go-back' }
        webview.goBack()
        return { ok: true }
      case 'forward':
        if (!webview.canGoForward()) return { ok: false, error: 'cannot-go-forward' }
        webview.goForward()
        return { ok: true }
      case 'reload':
        webview.reload()
        return { ok: true }
      case 'current': {
        const raw = webview.getURL()
        return {
          ok: true,
          result: {
            url: isStartPageUrl(raw) ? '' : raw,
            title: webview.getTitle(),
            canGoBack: webview.canGoBack(),
            canGoForward: webview.canGoForward(),
            loading: webview.isLoading(),
          },
        }
      }
      case 'screenshot': {
        const wcId = webview.getWebContentsId()
        // The CLI/agent path returns only the file path, so opt out of the
        // full-page base64 encode the UI button needs.
        let result: { filePath: string } | null
        try {
          result = await window.electronAPI.webviewScreenshot(wcId, { wantDataUrl: false })
        } catch {
          return { ok: false, error: 'screenshot-failed' }
        }
        if (!result) return { ok: false, error: 'screenshot-failed' }
        return { ok: true, result: { path: result.filePath } }
      }
      case 'snapshot': {
        const snap = await webview.executeJavaScript(SNAPSHOT_JS)
        return { ok: true, result: snap }
      }
      case 'click': {
        const ref = typeof args.ref === 'string' ? args.ref : undefined
        if (!ref) return { ok: false, error: 'ref-required' }
        const res = (await webview.executeJavaScript(clickJs(ref))) as { ok?: true; error?: string }
        if (res?.error) return { ok: false, error: res.error }
        return { ok: true }
      }
      case 'type': {
        const ref = typeof args.ref === 'string' ? args.ref : undefined
        if (!ref) return { ok: false, error: 'ref-required' }
        const text = typeof args.text === 'string' ? args.text : ''
        const res = (await webview.executeJavaScript(typeJs(ref, text))) as { ok?: true; error?: string }
        if (res?.error) return { ok: false, error: res.error }
        return { ok: true }
      }
      default:
        return { ok: false, error: 'unsupported' }
    }
  } catch {
    // A live webview whose guest process just went away throws on any call.
    return { ok: false, error: 'webview-not-ready' }
  }
}
