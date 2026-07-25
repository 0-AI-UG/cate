// =============================================================================
// browserDriver — renderer executor for the `cate.browser.*` reverse API.
//
// The main process forwards a guest's (CLI, agent or extension) `cate.browser.*`
// call to the window that owns the target browser panel; useCateHostActionResponder
// hands it here. We resolve WHICH browser panel the call targets, drive its live
// <webview> via the portalRegistry, and reply with a machine-readable outcome.
//
// Target resolution order (see resolveTargetPanelId):
//   1. explicit args.panelId — must be a browser panel in THIS window's store
//   2. the focused browser (active panel is a browser of this workspace)
//   3. the first browser panel in the workspace (matches terminalUrlOpen)
//
// Layering:
//   guestScripts.ts   what runs INSIDE the page (snapshot, locators, reads)
//   browserInput.ts   real trusted input + the agent-cursor events that make it
//                     visible on screen
//   browserControl    (main process) the ops needing a real webContents:
//                     full-page/element capture, viewport emulation, frames,
//                     downloads, clipboard
//
// Actions resolve a generation-scoped snapshot ref, auto-wait for an actionable
// target, then deliver real input. Refs from an older snapshot cannot silently
// address a different element.
// =============================================================================

import { useAppStore } from '../../stores/appStore'
import { getActivePanelId } from '../activePanel'
import { portalRegistry, type PortalWebview } from '../portalRegistry'
import { placementForBackgroundPanel } from '../workspace/canvasAccess'
import { readConsole, clearConsole, type ConsoleEntry } from './consoleBuffer'
import { cursorLabelText, emitAgentCursor } from './agentCursor'
import {
  actionabilityJs,
  assetsJs,
  attributesJs,
  checkedStateJs,
  focusForFillJs,
  focusForTypeJs,
  focusJs,
  installDialogHandlerJs,
  locateJs,
  readDialogsJs,
  scrollJs,
  selectOptionJs,
  snapshotJs,
  stateJs,
  textJs,
  waitConditionJs,
  type ActionMode,
  type LocatorBy,
  type LocatorQuery,
  type WaitCondition,
} from './guestScripts'
import {
  parseKeyCombo,
  sendClick,
  sendDrag,
  sendHover,
  sendWheel,
  type ClickOptions,
  type InputTarget,
} from './browserInput'
import type { PortalInputModifier } from '../portalRegistry'

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
  const placementGroupId = typeof args.placementGroupId === 'string' && args.placementGroupId
    ? args.placementGroupId
    : undefined
  if (placementGroupId) {
    const grouped = Object.values(ws?.panels ?? {}).find(
      (panel) => panel.type === 'browser' && panel.placementGroupId === placementGroupId,
    )
    return grouped ? { panelId: grouped.id } : { error: 'no-browser' }
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
async function waitForWebview(panelId: string, timeoutMs = 8_000): Promise<PortalWebview | null> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const webview = portalRegistry.get(panelId)
    if (webview) return webview
    if (Date.now() >= deadline) return null
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

async function navigateAndReadUrl(
  webview: PortalWebview,
  navigate: () => void,
  timeoutMs = 8_000,
): Promise<{ url: string } | { error: 'navigation-timeout' }> {
  return new Promise((resolve, reject) => {
    let settled = false
    const cleanup = () => {
      clearTimeout(timer)
      webview.removeEventListener('did-navigate', onNavigate)
      webview.removeEventListener('did-navigate-in-page', onNavigate)
    }
    const onNavigate = (event: { url?: string }) => {
      if (settled) return
      settled = true
      cleanup()
      resolve({ url: event.url ?? webview.getURL() })
    }
    webview.addEventListener('did-navigate', onNavigate)
    webview.addEventListener('did-navigate-in-page', onNavigate)
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      cleanup()
      resolve({ error: 'navigation-timeout' })
    }, timeoutMs)
    try {
      navigate()
    } catch (error) {
      settled = true
      cleanup()
      reject(error)
    }
  })
}

// --- Ref generations ---------------------------------------------------------
// `snapshot` opens a new generation and re-tags the page; `find` adds elements
// to the CURRENT generation so refs handed out earlier keep working. Tracking
// the counter per webview (not per panel) means a guest that navigated away and
// back gets a fresh generation with it.

interface Generation { id: string; next: number }
const generations = new WeakMap<PortalWebview, Generation>()

function newGeneration(webview: PortalWebview): Generation {
  const previous = generations.get(webview)
  const serial = previous ? Number(previous.id.slice(1)) + 1 : 1
  const generation: Generation = { id: `s${serial}`, next: 0 }
  generations.set(webview, generation)
  return generation
}

function currentGeneration(webview: PortalWebview): Generation {
  return generations.get(webview) ?? newGeneration(webview)
}

async function takeSnapshot(
  webview: PortalWebview,
  options: { selector?: string; max?: number } = {},
): Promise<unknown> {
  const generation = newGeneration(webview)
  const snap = await webview.executeJavaScript(
    snapshotJs(generation.id, options.selector, options.max ?? 0),
  ) as { nextIndex?: number } | undefined
  generation.next = typeof snap?.nextIndex === 'number' ? snap.nextIndex : 0
  return snap
}

async function locate(webview: PortalWebview, query: LocatorQuery): Promise<unknown> {
  const generation = currentGeneration(webview)
  const found = await webview.executeJavaScript(
    locateJs(generation.id, query, generation.next),
  ) as { nextIndex?: number } | undefined
  if (typeof found?.nextIndex === 'number') generation.next = found.nextIndex
  return found
}

/** Canonical refs are generation-scoped `@s<n>e<n>` tokens. The bare `s1e2` form
 *  is accepted too — it is what a shell hands over without quoting. */
function normalizeRef(raw: unknown): { ref: string } | { error: string } {
  if (typeof raw !== 'string' || raw === '') return { error: 'ref-required' }
  const ref = /^(?:s\d+)?e\d+$/.test(raw) ? `@${raw}` : raw
  if (!/^@(?:s\d+)?e\d+$/.test(ref)) return { error: 'bad-ref: expected a snapshot ref like @s12e7' }
  return { ref }
}

// --- Actionability -----------------------------------------------------------

const ACTION_TIMEOUT_MS = 3_000
const ACTION_POLL_MS = 50

interface ActionableTarget {
  x: number
  y: number
  box?: [number, number, number, number]
  name?: string
}

/** Poll until the ref resolves to a stable, visible, unobstructed point. The
 *  stability check (same rect twice) is what stops a click landing on a moving
 *  element mid-animation, which is how agents "click the wrong button". */
async function waitForActionable(
  webview: PortalWebview,
  ref: string,
  mode: ActionMode,
): Promise<{ target: ActionableTarget } | { error: string }> {
  const deadline = Date.now() + ACTION_TIMEOUT_MS
  let previousRect = ''
  let lastError = 'not-actionable'
  for (;;) {
    const result = await webview.executeJavaScript(actionabilityJs(ref, mode)) as {
      ok?: true; error?: string; x?: number; y?: number; rect?: string
      box?: [number, number, number, number]; name?: string
    }
    if (result.error === 'stale-ref') return { error: result.error }
    if (result.ok && typeof result.x === 'number' && typeof result.y === 'number') {
      if (result.rect && result.rect === previousRect) {
        return { target: { x: result.x, y: result.y, box: result.box, name: result.name } }
      }
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

async function postActionOutcome(
  webview: PortalWebview,
  args: Record<string, unknown>,
  extra?: Record<string, unknown>,
): Promise<BrowserOutcome> {
  if (args.includeSnapshot !== true) {
    return extra ? { ok: true, result: extra } : { ok: true }
  }
  return {
    ok: true,
    result: {
      ok: true,
      ...extra,
      url: webview.getURL(),
      title: webview.getTitle(),
      snapshot: await takeSnapshot(webview),
    },
  }
}

// --- Waiting -----------------------------------------------------------------

/** Wait must resolve WELL inside the main process's 10s forward timeout, so a
 *  caller-supplied timeout is capped at 8s. */
const WAIT_DEFAULT_MS = 5_000
const WAIT_MAX_MS = 8_000
const WAIT_POLL_MS = 100

function parseWaitCondition(raw: unknown): WaitCondition | { error: string } {
  if (raw === undefined) return { kind: 'load' }
  if (!raw || typeof raw !== 'object') return { error: 'bad-wait-condition' }
  const value = raw as Record<string, unknown>
  if (value.kind === 'load') return { kind: 'load' }
  if ((value.kind === 'text' || value.kind === 'textGone' || value.kind === 'url') && typeof value.value === 'string') {
    return { kind: value.kind, value: value.value }
  }
  const STATES = ['visible', 'hidden', 'attached', 'detached']
  if (value.kind === 'selector' && typeof value.value === 'string' && STATES.includes(String(value.state))) {
    return { kind: 'selector', value: value.value, state: value.state as 'visible' | 'hidden' | 'attached' | 'detached' }
  }
  if (value.kind === 'ref' && typeof value.ref === 'string' && STATES.includes(String(value.state))) {
    const ref = normalizeRef(value.ref)
    if ('error' in ref) return ref
    return { kind: 'ref', ref: ref.ref, state: value.state as 'visible' | 'hidden' | 'attached' | 'detached' }
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

// --- Argument helpers --------------------------------------------------------

function numberArg(args: Record<string, unknown>, key: string, fallback: number): number {
  const value = args[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  return typeof value === 'string' ? value : undefined
}

const MODIFIER_NAMES: PortalInputModifier[] = ['shift', 'control', 'alt', 'meta']

function modifierArgs(args: Record<string, unknown>): PortalInputModifier[] {
  const raw = args.modifiers
  if (!Array.isArray(raw)) return []
  return raw.filter((m): m is PortalInputModifier => MODIFIER_NAMES.includes(m as PortalInputModifier))
}

function clickOptions(args: Record<string, unknown>, clickCount = 1): ClickOptions {
  const button = stringArg(args, 'button')
  return {
    button: button === 'right' || button === 'middle' ? button : 'left',
    clickCount,
    modifiers: modifierArgs(args),
  }
}

function resolveTabId(
  tabs: Array<{ id: string }>,
  requested: string,
): { tabId: string } | { error: 'no-such-tab' | 'ambiguous-tab' } {
  const exact = tabs.find((tab) => tab.id === requested)
  if (exact) return { tabId: exact.id }
  const matches = tabs.filter((tab) => tab.id.startsWith(requested))
  if (matches.length === 1) return { tabId: matches[0].id }
  return { error: matches.length > 1 ? 'ambiguous-tab' : 'no-such-tab' }
}

const LOCATOR_KEYS: LocatorBy[] = ['role', 'text', 'label', 'placeholder', 'testid', 'css', 'altText', 'title']

function parseLocatorQuery(args: Record<string, unknown>): LocatorQuery | { error: string } {
  const by = stringArg(args, 'by')
  const value = stringArg(args, 'value')
  if (!by || !LOCATOR_KEYS.includes(by as LocatorBy)) {
    return { error: `bad-locator: expected one of ${LOCATOR_KEYS.join('|')}` }
  }
  if (value === undefined || value === '') return { error: 'value-required' }
  const nth = typeof args.nth === 'number' ? args.nth : undefined
  return { by: by as LocatorBy, value, ...(nth !== undefined ? { nth } : {}), exact: args.exact === true }
}

/** Resolve a ref OR a locator into a single actionable target. Every acting verb
 *  accepts both, so an agent can click something it just found without a
 *  snapshot round trip. */
async function resolveActionTarget(
  webview: PortalWebview,
  args: Record<string, unknown>,
  mode: ActionMode,
): Promise<{ ref: string; target: ActionableTarget } | { error: string }> {
  let ref: string
  if (args.ref !== undefined) {
    const normalized = normalizeRef(args.ref)
    if ('error' in normalized) return { error: normalized.error }
    ref = normalized.ref
  } else if (args.by !== undefined) {
    const query = parseLocatorQuery(args)
    if ('error' in query) return { error: query.error }
    // A locator that matches several elements is ambiguous for an ACTION —
    // acting on "the first of 12" silently is how agents click the wrong thing.
    // Require nth to disambiguate.
    const found = await locate(webview, query) as { refs?: Array<{ ref: string }>; error?: string }
    if (found?.error) return { error: found.error }
    const refs = found?.refs ?? []
    if (!refs.length) return { error: 'no-match' }
    if (refs.length > 1 && query.nth === undefined) return { error: `ambiguous:${refs.length}` }
    ref = refs[0].ref
  } else {
    return { error: 'ref-or-locator-required' }
  }
  const actionable = await waitForActionable(webview, ref, mode)
  if ('error' in actionable) return { error: actionable.error }
  return { ref, target: actionable.target }
}

// --- Main-process control ----------------------------------------------------

async function control(
  webview: PortalWebview,
  request: Omit<Parameters<typeof window.electronAPI.browserControl>[0], 'webContentsId'>,
): Promise<Awaited<ReturnType<typeof window.electronAPI.browserControl>>> {
  return window.electronAPI.browserControl({ ...request, webContentsId: webview.getWebContentsId() })
}

const PLAYWRIGHT_MODIFIERS = {
  alt: 'Alt',
  control: 'Control',
  meta: 'Meta',
  shift: 'Shift',
} as const

function playwrightModifiers(modifiers: PortalInputModifier[]): Array<'Alt' | 'Control' | 'Meta' | 'Shift'> {
  return modifiers.map((modifier) => PLAYWRIGHT_MODIFIERS[modifier])
}

/** Return null only when the Playwright target has not attached yet, allowing
 *  the legacy webContents input path to keep the browser usable during startup
 *  or if CDP is unavailable. Any real Playwright action error is surfaced. */
async function tryPlaywright(
  webview: PortalWebview,
  request: Omit<Parameters<typeof window.electronAPI.browserControl>[0], 'op' | 'webContentsId'>,
): Promise<BrowserOutcome | null> {
  const result = await control(webview, { op: 'playwright', ...request })
  if (result.error === 'playwright-unavailable') return null
  if (result.error) return { ok: false, error: result.error }
  return { ok: true }
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
  // responder) is the single panel-enumeration surface. `tabs` below lists the
  // tabs WITHIN one browser panel, which is a different question.

  // `open` may create a browser when none exists; resolve/handle specially.
  if (name === 'open') {
    const url = stringArg(args, 'url')
    if (!url) return { ok: false, error: 'url-required' }
    const target = resolveTargetPanelId(workspaceId, args)
    let panelId: string
    if ('error' in target) {
      if (target.error === 'no-browser') {
        panelId = useAppStore.getState().createBrowser(
          workspaceId,
          url,
          undefined,
          placementForBackgroundPanel(workspaceId, stringArg(args, 'placementGroupId')),
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
        const result = await navigateAndReadUrl(webview, () => webview.loadURL(url))
        return 'error' in result
          ? { ok: false, error: result.error }
          : { ok: true, result: { panelId, url: result.url } }
      } catch {
        return { ok: false, error: 'webview-not-ready' }
      }
    }
    // No live webview: the panel was just created above, is still mounting, or
    // sits on its start page — which renders INSTEAD of a webview and would
    // never mount one on its own. The panel's registered controller is the same
    // entry point the URL bar uses; navigating leaves the start page, which
    // mounts the webview.
    portalRegistry.getController(panelId)?.navigate(url)
    const mounted = await waitForWebview(panelId)
    if (!mounted) {
      // Distinguish "no panel is rendering this" from "the guest is slow": a
      // panel with no controller is not mounted anywhere in this window, which
      // no amount of waiting fixes.
      return {
        ok: false,
        error: portalRegistry.getController(panelId) ? 'webview-not-ready' : 'panel-not-mounted',
      }
    }
    try {
      const result = await navigateAndReadUrl(mounted, () => mounted.loadURL(url))
      return 'error' in result
        ? { ok: false, error: result.error }
        : { ok: true, result: { panelId, url: result.url } }
    } catch {
      return { ok: false, error: 'webview-not-ready' }
    }
  }

  // Tab verbs act on panel state, not on the guest: they work even while the
  // panel sits on its start page (no webview), so they resolve before the
  // webview requirement below.
  if (name === 'tabs' || name === 'tabNew' || name === 'tabSelect' || name === 'tabClose') {
    const target = resolveTargetPanelId(workspaceId, args)
    if ('error' in target) return { ok: false, error: target.error }
    const controller = portalRegistry.getController(target.panelId)
    if (!controller) return { ok: false, error: 'panel-not-mounted' }
    switch (name) {
      case 'tabs':
        return { ok: true, result: { panelId: target.panelId, tabs: controller.listTabs() } }
      case 'tabNew': {
        const tabId = controller.newTab(stringArg(args, 'url'))
        return { ok: true, result: { panelId: target.panelId, tabId } }
      }
      case 'tabSelect': {
        const requested = stringArg(args, 'tabId')
        if (!requested) return { ok: false, error: 'tabId-required' }
        const resolved = resolveTabId(controller.listTabs(), requested)
        if ('error' in resolved) return { ok: false, error: resolved.error }
        return controller.selectTab(resolved.tabId)
          ? { ok: true, result: { tabId: resolved.tabId } }
          : { ok: false, error: 'no-such-tab' }
      }
      default: {
        const requested = stringArg(args, 'tabId')
        if (!requested) return { ok: false, error: 'tabId-required' }
        const resolved = resolveTabId(controller.listTabs(), requested)
        if ('error' in resolved) return { ok: false, error: resolved.error }
        return controller.closeTab(resolved.tabId)
          ? { ok: true, result: { tabId: resolved.tabId } }
          : { ok: false, error: 'no-such-tab' }
      }
    }
  }

  // Every remaining method needs an existing, dom-ready browser.
  const target = resolveTargetPanelId(workspaceId, args)
  if ('error' in target) return { ok: false, error: target.error }
  const found = getWebview(target.panelId)
  if ('error' in found) {
    return {
      ok: false,
      error: portalRegistry.getController(target.panelId) ? found.error : 'panel-not-mounted',
    }
  }
  const { webview } = found
  const input: InputTarget = { webview, panelId: target.panelId }

  try {
    switch (name) {
      // --- Navigation ------------------------------------------------------
      case 'reload':
        webview.reload()
        return { ok: true }
      case 'back':
        if (!webview.canGoBack()) return { ok: false, error: 'no-history' }
        {
          const result = await navigateAndReadUrl(webview, () => webview.goBack())
          return 'error' in result
            ? { ok: false, error: result.error }
            : { ok: true, result }
        }
      case 'forward':
        if (!webview.canGoForward()) return { ok: false, error: 'no-history' }
        {
          const result = await navigateAndReadUrl(webview, () => webview.goForward())
          return 'error' in result
            ? { ok: false, error: result.error }
            : { ok: true, result }
        }
      case 'current':
        return {
          ok: true,
          result: {
            panelId: target.panelId,
            url: webview.getURL(),
            title: webview.getTitle(),
            loading: webview.isLoading(),
            canGoBack: webview.canGoBack(),
            canGoForward: webview.canGoForward(),
          },
        }

      // --- Inspection ------------------------------------------------------
      case 'snapshot': {
        const snap = await takeSnapshot(webview, {
          selector: stringArg(args, 'selector'),
          max: numberArg(args, 'max', 0),
        })
        return { ok: true, result: snap }
      }
      case 'find': {
        const query = parseLocatorQuery(args)
        if ('error' in query) return { ok: false, error: query.error }
        const result = await locate(webview, query) as { error?: string }
        if (result?.error) return { ok: false, error: result.error }
        return { ok: true, result }
      }
      case 'text': {
        const ref = args.ref === undefined ? '' : normalizeRef(args.ref)
        if (typeof ref !== 'string' && 'error' in ref) return { ok: false, error: ref.error }
        const result = await webview.executeJavaScript(
          textJs(typeof ref === 'string' ? '' : ref.ref, numberArg(args, 'max', 20_000)),
        ) as { error?: string }
        if (result?.error) return { ok: false, error: result.error }
        return { ok: true, result }
      }
      case 'attrs': {
        const ref = normalizeRef(args.ref)
        if ('error' in ref) return { ok: false, error: ref.error }
        const result = await webview.executeJavaScript(attributesJs(ref.ref)) as { error?: string }
        if (result?.error) return { ok: false, error: result.error }
        return { ok: true, result }
      }
      case 'state': {
        const ref = normalizeRef(args.ref)
        if ('error' in ref) return { ok: false, error: ref.error }
        const result = await webview.executeJavaScript(stateJs(ref.ref)) as { error?: string }
        if (result?.error) return { ok: false, error: result.error }
        return { ok: true, result }
      }
      case 'assets': {
        const result = await webview.executeJavaScript(assetsJs(numberArg(args, 'max', 50)))
        return { ok: true, result }
      }
      case 'evaluate': {
        const expression = stringArg(args, 'expression')
        if (!expression) return { ok: false, error: 'expression-required' }
        // Wrapped so the caller can pass either an expression or a statement
        // body, and so a thrown error comes back as data instead of rejecting.
        const wrapped = `(function () { try { return { value: eval(${JSON.stringify(expression)}) } } ` +
          `catch (e) { return { error: String(e && e.message ? e.message : e) } } })()`
        const result = await webview.executeJavaScript(wrapped) as { value?: unknown; error?: string }
        if (result?.error) return { ok: false, error: `eval-failed: ${result.error}` }
        return { ok: true, result: { value: result?.value ?? null } }
      }
      case 'console': {
        const level = stringArg(args, 'level') as ConsoleEntry['level'] | undefined
        return {
          ok: true,
          result: { entries: readConsole(target.panelId, numberArg(args, 'max', 100), level) },
        }
      }
      case 'consoleClear':
        clearConsole(target.panelId)
        return { ok: true }

      // --- Dialogs ---------------------------------------------------------
      case 'dialogPolicy': {
        const policy = stringArg(args, 'policy')
        if (policy !== 'accept' && policy !== 'dismiss') return { ok: false, error: 'policy-required: accept|dismiss' }
        const result = await webview.executeJavaScript(
          installDialogHandlerJs(policy, stringArg(args, 'promptText') ?? ''),
        )
        return { ok: true, result }
      }
      case 'dialogs': {
        const result = await webview.executeJavaScript(readDialogsJs())
        return { ok: true, result }
      }

      // --- Interaction -----------------------------------------------------
      case 'click':
      case 'dblclick': {
        const resolved = await resolveActionTarget(webview, args, 'click')
        if ('error' in resolved) return { ok: false, error: resolved.error }
        const { x, y, box, name: label } = resolved.target
        // The ref/locator was resolved and actionability-checked inside this
        // exact guest. Deliver the click to that same guest webContents; the
        // CDP adapter can expose a parallel page target whose Playwright
        // hit-test waits forever even though the visible guest is actionable.
        await sendClick(input, x, y, clickOptions(args, 1), {
          kind: name === 'dblclick' ? 'dblclick' : 'click',
          rect: box,
          label: `${name === 'dblclick' ? 'double-click' : 'click'} ${cursorLabelText(label ?? '')}`.trim(),
        })
        if (name === 'dblclick') {
          // Electron delivers a double click as two events with clickCount 1
          // then 2; the first press is what focuses, the second is the dblclick.
          await sendClick(input, x, y, clickOptions(args, 2), {
            kind: 'dblclick', rect: box, label: `double-click ${cursorLabelText(label ?? '')}`.trim(),
          })
        }
        return postActionOutcome(webview, args, { ref: resolved.ref })
      }
      case 'hover': {
        const resolved = await resolveActionTarget(webview, args, 'hover')
        if ('error' in resolved) return { ok: false, error: resolved.error }
        const { x, y, box, name: label } = resolved.target
        emitAgentCursor(target.panelId, {
          kind: 'hover', x, y, rect: box,
          label: `hover ${cursorLabelText(label ?? '')}`.trim(),
        })
        const playwright = await tryPlaywright(webview, {
          action: 'hover',
          ref: resolved.ref,
        })
        if (playwright) {
          return playwright.ok
            ? postActionOutcome(webview, args, { ref: resolved.ref })
            : playwright
        }
        await sendHover(input, x, y, `hover ${cursorLabelText(label ?? '')}`.trim(), box)
        return postActionOutcome(webview, args, { ref: resolved.ref })
      }
      case 'fill':
      case 'type': {
        const resolved = await resolveActionTarget(webview, args, 'fill')
        if ('error' in resolved) return { ok: false, error: resolved.error }
        const text = stringArg(args, 'text') ?? ''
        const { x, y, box, name: label } = resolved.target
        // Show the pointer arriving at the field before the keystrokes, so the
        // overlay explains WHERE the text is going.
        emitAgentCursor(target.panelId, {
          kind: 'move', x, y, rect: box,
          label: `${name} ${cursorLabelText(label ?? '')}`.trim(),
        })
        const focusScript = name === 'fill' ? focusForFillJs(resolved.ref) : focusForTypeJs(resolved.ref)
        const focused = await webview.executeJavaScript(focusScript) as { error?: string }
        if (focused?.error) return { ok: false, error: focused.error }
        const inserted = await control(webview, {
          op: 'input',
          input: name === 'fill' ? 'replaceText' : 'insertText',
          text,
          ...(name === 'type' ? { delay: numberArg(args, 'delay', 0) } : {}),
        })
        if (inserted.error) return { ok: false, error: inserted.error }
        return postActionOutcome(webview, args, { ref: resolved.ref })
      }
      case 'press': {
        const raw = stringArg(args, 'key')
        const key = raw ? parseKeyCombo(raw) : null
        if (!key) return { ok: false, error: 'unsupported-key' }
        // Optional ref/locator: focus the element first (Enter into a field, Tab
        // from a field). Without one the key goes to whatever the guest has
        // focused — that's how page-level keys (Escape, PageDown) work.
        if (args.ref !== undefined || args.by !== undefined) {
          const resolved = await resolveActionTarget(webview, args, 'click')
          if ('error' in resolved) return { ok: false, error: resolved.error }
          const res = await webview.executeJavaScript(focusJs(resolved.ref)) as { error?: string }
          if (res?.error) return { ok: false, error: res.error }
        }
        emitAgentCursor(target.panelId, { kind: 'press', label: `press ${raw}` })
        const pressed = await control(webview, {
          op: 'input',
          input: 'key',
          key: key.keyCode,
          modifiers: playwrightModifiers(key.modifiers),
        })
        if (pressed.error) return { ok: false, error: pressed.error }
        return postActionOutcome(webview, args)
      }
      case 'select': {
        const values = Array.isArray(args.values)
          ? args.values.filter((v): v is string => typeof v === 'string')
          : typeof args.value === 'string' ? [args.value] : []
        if (!values.length) return { ok: false, error: 'value-required' }
        const resolved = await resolveActionTarget(webview, args, 'select')
        if ('error' in resolved) return { ok: false, error: resolved.error }
        const { x, y, box } = resolved.target
        emitAgentCursor(target.panelId, { kind: 'click', x, y, rect: box, label: `select "${cursorLabelText(values.join(', '), 24)}"` })
        const playwright = await tryPlaywright(webview, {
          action: 'select',
          ref: resolved.ref,
          values,
        })
        if (playwright) {
          return playwright.ok
            ? postActionOutcome(webview, args, { ref: resolved.ref, values })
            : playwright
        }
        const result = await webview.executeJavaScript(selectOptionJs(resolved.ref, values)) as { error?: string }
        if (result?.error) return { ok: false, error: result.error }
        return postActionOutcome(webview, args, { ref: resolved.ref, ...result })
      }
      case 'check':
      case 'uncheck': {
        const want = name === 'check'
        const resolved = await resolveActionTarget(webview, args, 'check')
        if ('error' in resolved) return { ok: false, error: resolved.error }
        const current = await webview.executeJavaScript(checkedStateJs(resolved.ref)) as
          { checked?: boolean; error?: string }
        if (current?.error) return { ok: false, error: current.error }
        // Idempotent by contract: only click when the state must change, so
        // `check` twice leaves it checked instead of toggling it back off.
        if (current?.checked === want) {
          return postActionOutcome(webview, args, { ref: resolved.ref, checked: want, changed: false })
        }
        const { x, y, box, name: label } = resolved.target
        emitAgentCursor(target.panelId, {
          kind: 'click', x, y, rect: box,
          label: `${name} ${cursorLabelText(label ?? '')}`.trim(),
        })
        const playwright = await tryPlaywright(webview, {
          action: name,
          ref: resolved.ref,
        })
        if (playwright) {
          return playwright.ok
            ? postActionOutcome(webview, args, { ref: resolved.ref, checked: want, changed: true })
            : playwright
        }
        await sendClick(input, x, y, clickOptions(args), {
          kind: 'click', rect: box, label: `${name} ${cursorLabelText(label ?? '')}`.trim(),
        })
        return postActionOutcome(webview, args, { ref: resolved.ref, checked: want, changed: true })
      }
      case 'drag': {
        const fromArgs = { ...args, ref: args.ref ?? args.from }
        const toRef = normalizeRef(args.to)
        if ('error' in toRef) return { ok: false, error: `to: ${toRef.error}` }
        const from = await resolveActionTarget(webview, fromArgs, 'click')
        if ('error' in from) return { ok: false, error: `from: ${from.error}` }
        const to = await waitForActionable(webview, toRef.ref, 'click')
        if ('error' in to) return { ok: false, error: `to: ${to.error}` }
        emitAgentCursor(target.panelId, {
          kind: 'drag',
          x: from.target.x,
          y: from.target.y,
          toX: to.target.x,
          toY: to.target.y,
          label: `drag ${cursorLabelText(from.target.name ?? '')}`.trim(),
        })
        const playwright = await tryPlaywright(webview, {
          action: 'drag',
          ref: from.ref,
          targetRef: toRef.ref,
        })
        if (playwright) {
          return playwright.ok
            ? postActionOutcome(webview, args, { from: from.ref, to: toRef.ref })
            : playwright
        }
        await sendDrag(input, from.target, to.target, `drag ${cursorLabelText(from.target.name ?? '')}`.trim())
        return postActionOutcome(webview, args, { from: from.ref, to: toRef.ref })
      }
      case 'scroll': {
        // Wheel input when a point is in play (that's what a page's scroll
        // handlers listen for); the scripted path for "scroll this container to
        // the bottom", which no wheel delta can express reliably.
        const to = stringArg(args, 'to')
        const dx = numberArg(args, 'dx', 0)
        const dy = numberArg(args, 'dy', 0)
        let ref = ''
        if (args.ref !== undefined) {
          const normalized = normalizeRef(args.ref)
          if ('error' in normalized) return { ok: false, error: normalized.error }
          ref = normalized.ref
        }
        if (to === 'top' || to === 'bottom' || ref) {
          const result = await webview.executeJavaScript(
            scrollJs(ref, dx, dy, to === 'top' || to === 'bottom' ? to : undefined),
          ) as { error?: string }
          if (result?.error) return { ok: false, error: result.error }
          emitAgentCursor(target.panelId, { kind: 'scroll', label: to ? `scroll ${to}` : `scroll ${dx},${dy}` })
          return postActionOutcome(webview, args, result as Record<string, unknown>)
        }
        const x = numberArg(args, 'x', 400)
        const y = numberArg(args, 'y', 300)
        await sendWheel(input, x, y, dx, dy, `scroll ${dx},${dy}`)
        return postActionOutcome(webview, args)
      }
      case 'mouse': {
        // Raw coordinate control — the escape hatch for canvases, maps and
        // custom widgets that have no addressable DOM element.
        const action = stringArg(args, 'action') ?? 'click'
        const x = numberArg(args, 'x', -1)
        const y = numberArg(args, 'y', -1)
        if (x < 0 || y < 0) return { ok: false, error: 'x-and-y-required' }
        if (action === 'drag') {
          const toX = numberArg(args, 'toX', -1)
          const toY = numberArg(args, 'toY', -1)
          if (toX < 0 || toY < 0) return { ok: false, error: 'toX-and-toY-required' }
          await sendDrag(input, { x, y }, { x: toX, y: toY }, `drag ${x},${y} → ${toX},${toY}`)
          return postActionOutcome(webview, args)
        }
        if (action === 'move') {
          await sendHover(input, x, y, `move ${x},${y}`)
          return postActionOutcome(webview, args)
        }
        if (action === 'down' || action === 'up') {
          emitAgentCursor(target.panelId, { kind: 'click', x, y, label: `mouse ${action} ${x},${y}` })
          await webview.sendInputEvent({
            type: action === 'down' ? 'mouseDown' : 'mouseUp',
            x, y,
            button: clickOptions(args).button,
            clickCount: 1,
            modifiers: modifierArgs(args),
          })
          return postActionOutcome(webview, args)
        }
        if (action !== 'click') return { ok: false, error: 'unsupported-mouse-action' }
        await sendClick(input, x, y, clickOptions(args, numberArg(args, 'clickCount', 1)), {
          kind: 'click', label: `click ${x},${y}`,
        })
        return postActionOutcome(webview, args)
      }

      // --- Visual ----------------------------------------------------------
      case 'screenshot': {
        const mode = stringArg(args, 'mode')
        if (mode === 'element') {
          const resolved = await resolveActionTarget(webview, args, 'hover')
          if ('error' in resolved) return { ok: false, error: resolved.error }
          const box = resolved.target.box
          if (!box) return { ok: false, error: 'no-element-box' }
          const [x, y, width, height] = box
          const shot = await control(webview, {
            op: 'screenshot', mode: 'rect', rect: { x, y, width, height },
          })
          if (shot.error || !shot.filePath) return { ok: false, error: shot.error ?? 'screenshot-failed' }
          return { ok: true, result: { path: shot.filePath, ref: resolved.ref } }
        }
        if (mode === 'fullPage') {
          const shot = await control(webview, { op: 'screenshot', mode: 'fullPage' })
          if (shot.error || !shot.filePath) return { ok: false, error: shot.error ?? 'screenshot-failed' }
          return { ok: true, result: { path: shot.filePath } }
        }
        // Viewport capture uses the existing webview IPC. It already enforces
        // guest ownership and avoids carrying a base64 image over IPC.
        const wcId = webview.getWebContentsId()
        let result: { filePath: string } | null
        try {
          result = await window.electronAPI.webviewScreenshot(
            wcId,
            { wantDataUrl: false, saveTo: 'temp' },
          )
        } catch {
          return { ok: false, error: 'screenshot-failed' }
        }
        if (!result) return { ok: false, error: 'screenshot-failed' }
        return { ok: true, result: { path: result.filePath } }
      }

      // --- Waiting ---------------------------------------------------------
      case 'wait': {
        const timeoutMs = numberArg(args, 'timeoutMs', WAIT_DEFAULT_MS)
        const condition = parseWaitCondition(args.condition)
        if ('error' in condition) return { ok: false, error: condition.error }
        return await waitForCondition(webview, timeoutMs, condition, args.includeSnapshot === true)
      }

      // --- Environment -----------------------------------------------------
      case 'viewport': {
        const width = numberArg(args, 'width', 0)
        const height = numberArg(args, 'height', 0)
        const reset = args.reset === true || (width === 0 && height === 0)
        const result = await control(webview, {
          op: 'setViewport',
          viewport: reset ? null : {
            width, height,
            deviceScaleFactor: numberArg(args, 'deviceScaleFactor', 0),
            mobile: args.mobile === true,
          },
        })
        if (result.error) return { ok: false, error: result.error }
        return { ok: true, result }
      }
      case 'frames': {
        const result = await control(webview, { op: 'frames' })
        if (result.error) return { ok: false, error: result.error }
        return { ok: true, result: { frames: result.frames ?? [] } }
      }
      case 'frameEval': {
        const expression = stringArg(args, 'expression')
        if (!expression) return { ok: false, error: 'expression-required' }
        const routingId = numberArg(args, 'frameRoutingId', -1)
        const processId = numberArg(args, 'frameProcessId', -1)
        if (routingId < 0 || processId < 0) return { ok: false, error: 'frame-required' }
        const result = await control(webview, {
          op: 'frameEval', frameRoutingId: routingId, frameProcessId: processId, code: expression,
        })
        if (result.error) return { ok: false, error: result.error }
        return { ok: true, result: { value: result.value ?? null } }
      }
      case 'downloads': {
        const result = await control(webview, { op: 'downloads' })
        if (result.error) return { ok: false, error: result.error }
        return { ok: true, result: { downloads: result.downloads ?? [] } }
      }
      case 'clipboardRead': {
        const result = await control(webview, { op: 'clipboardRead' })
        if (result.error) return { ok: false, error: result.error }
        return { ok: true, result: { text: result.text ?? '' } }
      }
      case 'clipboardWrite': {
        const text = stringArg(args, 'text')
        if (text === undefined) return { ok: false, error: 'text-required' }
        const result = await control(webview, { op: 'clipboardWrite', text })
        if (result.error) return { ok: false, error: result.error }
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
