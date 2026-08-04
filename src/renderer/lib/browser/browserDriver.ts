// =============================================================================
// browserDriver — renderer routing for the `cate.browser.*` reverse API.
//
// The renderer owns browser panel selection, tab state, and visible agent
// activity. All page observation and interaction is performed by the required
// main-process agent-browser service. No automation JavaScript is injected into
// the guest and there is no secondary input backend.
// =============================================================================

import { useAppStore } from '../../stores/appStore'
import { getActivePanelId } from '../activePanel'
import { portalRegistry, type PortalWebview } from '../portalRegistry'
import {
  getCanvasOpsById,
  placementForBackgroundPanel,
  resolvePanelLocation,
} from '../workspace/canvasAccess'
import { emitAgentCursor, emitBrowserContentChanged } from './agentCursor'
import { isBrowserInternalPage } from './internalPages'
import { PANEL_MINIMUM_SIZES } from '../../../shared/types'
import {
  agentBrowserActivityLabel,
  agentBrowserCommandShowsActivity,
  isReadOnlyAgentBrowserCommand,
  validateAgentBrowserCommand,
} from '../../../shared/agentBrowserCommand'

export type BrowserOutcome = { ok: true; result?: unknown } | { ok: false; error: string }

const ACTING_METHODS = new Set([
  'click',
  'dblclick',
  'hover',
  'fill',
  'type',
  'press',
  'select',
  'check',
  'uncheck',
  'drag',
  'scroll',
  'mouse',
])

export function findBrowserPanelId(workspaceId: string): string | null {
  const workspace = useAppStore.getState().workspaces.find((item) => item.id === workspaceId)
  if (!workspace) return null
  for (const panel of Object.values(workspace.panels)) {
    if (panel.type === 'browser') return panel.id
  }
  return null
}

function resolveTargetPanelId(
  workspaceId: string,
  args: Record<string, unknown>,
): { panelId: string } | { error: string } {
  const workspace = useAppStore.getState().workspaces.find((item) => item.id === workspaceId)
  const explicit = typeof args.panelId === 'string' ? args.panelId : undefined
  if (explicit) {
    const panel = workspace?.panels?.[explicit]
    return panel?.type === 'browser' ? { panelId: explicit } : { error: 'panel-not-in-window' }
  }
  const placementGroupId = typeof args.placementGroupId === 'string' ? args.placementGroupId : undefined
  if (placementGroupId) {
    const grouped = Object.values(workspace?.panels ?? {}).find(
      (panel) => panel.type === 'browser' && panel.placementGroupId === placementGroupId,
    )
    return grouped ? { panelId: grouped.id } : { error: 'no-browser' }
  }
  const active = getActivePanelId()
  if (active && workspace?.panels?.[active]?.type === 'browser') return { panelId: active }
  const first = findBrowserPanelId(workspaceId)
  return first ? { panelId: first } : { error: 'no-browser' }
}

async function waitForWebview(
  panelId: string,
  timeoutMs = 8_000,
  previous?: PortalWebview | null,
): Promise<PortalWebview | null> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const webview = portalRegistry.get(panelId)
    if (webview && (previous === undefined || webview !== previous)) return webview
    if (Date.now() >= deadline) return null
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

async function waitForController(panelId: string, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const controller = portalRegistry.getController(panelId)
    if (controller) return controller
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

async function waitForGuestReady(
  webview: PortalWebview,
  requestedUrl: string,
  timeoutMs = 8_000,
): Promise<{ url: string } | { error: 'navigation-timeout' }> {
  const needsNavigation = requestedUrl !== 'about:blank'
  return new Promise((resolve) => {
    let settled = false
    let navigated = !needsNavigation || webview.getURL() !== 'about:blank'
    const cleanup = () => {
      clearTimeout(timer)
      webview.removeEventListener('did-navigate', onNavigate)
      webview.removeEventListener('did-navigate-in-page', onNavigate)
      webview.removeEventListener('did-stop-loading', onLoadStop)
    }
    const finishIfReady = () => {
      if (settled || !navigated || webview.isLoading()) return
      settled = true
      cleanup()
      resolve({ url: webview.getURL() })
    }
    const onNavigate = (event: { url?: string }) => {
      if (!needsNavigation || (event.url ?? webview.getURL()) !== 'about:blank') navigated = true
      finishIfReady()
    }
    const onLoadStop = () => finishIfReady()
    webview.addEventListener('did-navigate', onNavigate)
    webview.addEventListener('did-navigate-in-page', onNavigate)
    webview.addEventListener('did-stop-loading', onLoadStop)
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      cleanup()
      resolve({ error: 'navigation-timeout' })
    }, timeoutMs)
    finishIfReady()
  })
}

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  return typeof args[key] === 'string' ? args[key] as string : undefined
}

function positiveNumberArg(args: Record<string, unknown>, key: string): number | null {
  const value = args[key]
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
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

async function control(
  webview: PortalWebview,
  request: Omit<Parameters<typeof window.electronAPI.browserControl>[0], 'webContentsId'>,
): Promise<Awaited<ReturnType<typeof window.electronAPI.browserControl>>> {
  return window.electronAPI.browserControl({ ...request, webContentsId: webview.getWebContentsId() })
}

function activityLabel(method: string, args: Record<string, unknown>): string {
  if (method === 'fill' || method === 'type') {
    const text = typeof args.text === 'string' ? args.text.replace(/\s+/g, ' ').trim() : ''
    const short = text.length > 28 ? `${text.slice(0, 27)}…` : text
    return `${method} ${JSON.stringify(short)}`
  }
  if (method === 'press') return `press ${String(args.key ?? '')}`.trim()
  return method
}

async function executeAgentBrowser(
  webview: PortalWebview,
  panelId: string,
  method: string,
  args: Record<string, unknown>,
): Promise<BrowserOutcome> {
  let commandActivity: string[] | null = null
  if (method === 'command' || method === 'readCommand') {
    try {
      commandActivity = validateAgentBrowserCommand(args.command)
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'invalid-browser-command' }
    }
  }
  if (ACTING_METHODS.has(method) || (commandActivity && agentBrowserCommandShowsActivity(commandActivity))) {
    emitAgentCursor(panelId, {
      kind: method === 'press' ? 'press' : method === 'scroll' ? 'scroll' : 'move',
      label: commandActivity ? agentBrowserActivityLabel(commandActivity) : activityLabel(method, args),
    })
  }
  const response = await control(webview, { op: 'agentBrowser', method, args })
  if (response.error) return { ok: false, error: response.error }
  if (response.cursor) emitAgentCursor(panelId, response.cursor)
  if (
    ACTING_METHODS.has(method)
    || method === 'evaluate'
    || method === 'dialogPolicy'
    || (commandActivity !== null && !isReadOnlyAgentBrowserCommand(commandActivity))
  ) {
    emitBrowserContentChanged(panelId)
  }
  return response.result === undefined ? { ok: true } : { ok: true, result: response.result }
}

export async function handleBrowserMethod(
  workspaceId: string,
  method: string,
  args: Record<string, unknown>,
): Promise<BrowserOutcome> {
  const name = method.slice('cate.browser.'.length)

  if (name === 'open') {
    const url = stringArg(args, 'url')
    if (!url) return { ok: false, error: 'url-required' }
    if (args.newTab === true && args.newPanel !== true) {
      const target = resolveTargetPanelId(workspaceId, args)
      if (!('error' in target)) {
        const controller = await waitForController(target.panelId)
        if (!controller) return { ok: false, error: 'panel-not-mounted' }
        const previous = portalRegistry.get(target.panelId)
        const tabId = controller.newTab(url)
        const mounted = await waitForWebview(target.panelId, 8_000, previous)
        if (!mounted) return { ok: false, error: 'webview-not-ready' }
        const ready = await waitForGuestReady(mounted, url)
        return 'error' in ready
          ? { ok: false, error: ready.error }
          : { ok: true, result: { panelId: target.panelId, tabId, url: ready.url } }
      }
      if (target.error !== 'no-browser') return { ok: false, error: target.error }
    }
    let panelId: string
    if (args.newPanel === true) {
      panelId = useAppStore.getState().createBrowser(
        workspaceId,
        url,
        undefined,
        placementForBackgroundPanel(workspaceId, stringArg(args, 'placementGroupId')),
      )
    } else {
      const target = resolveTargetPanelId(workspaceId, args)
      if ('error' in target) {
        if (target.error !== 'no-browser') return { ok: false, error: target.error }
        panelId = useAppStore.getState().createBrowser(
          workspaceId,
          url,
          undefined,
          placementForBackgroundPanel(workspaceId, stringArg(args, 'placementGroupId')),
        )
      } else {
        panelId = target.panelId
      }
    }

    useAppStore.getState().updateBrowserActiveTabUrl(workspaceId, panelId, url)
    const existing = portalRegistry.get(panelId)
    if (existing) {
      try {
        const result = await navigateAndReadUrl(existing, () => existing.loadURL(url))
        return 'error' in result ? { ok: false, error: result.error } : { ok: true, result: { panelId, url: result.url } }
      } catch {
        return { ok: false, error: 'webview-not-ready' }
      }
    }

    portalRegistry.getController(panelId)?.navigate(url)
    const mounted = await waitForWebview(panelId)
    if (!mounted) {
      return {
        ok: false,
        error: portalRegistry.getController(panelId) ? 'webview-not-ready' : 'panel-not-mounted',
      }
    }
    try {
      const result = await navigateAndReadUrl(mounted, () => mounted.loadURL(url))
      return 'error' in result ? { ok: false, error: result.error } : { ok: true, result: { panelId, url: result.url } }
    } catch {
      return { ok: false, error: 'webview-not-ready' }
    }
  }

  if (name === 'tabs' || name === 'tabNew' || name === 'tabSelect' || name === 'tabClose') {
    const target = resolveTargetPanelId(workspaceId, args)
    if ('error' in target) return { ok: false, error: target.error }
    const controller = await waitForController(target.panelId)
    if (!controller) return { ok: false, error: 'panel-not-mounted' }
    if (name === 'tabs') return { ok: true, result: { panelId: target.panelId, tabs: controller.listTabs() } }
    if (name === 'tabNew') {
      const previous = portalRegistry.get(target.panelId)
      const tabId = controller.newTab(stringArg(args, 'url'))
      const mounted = await waitForWebview(target.panelId, 8_000, previous)
      if (!mounted) return { ok: false, error: 'webview-not-ready' }
      const url = stringArg(args, 'url')
      if (url) {
        const ready = await waitForGuestReady(mounted, url)
        if ('error' in ready) return { ok: false, error: ready.error }
      }
      return { ok: true, result: { panelId: target.panelId, tabId } }
    }
    const requested = stringArg(args, 'tabId')
    if (!requested) return { ok: false, error: 'tabId-required' }
    const resolved = resolveTabId(controller.listTabs(), requested)
    if ('error' in resolved) return { ok: false, error: resolved.error }
    const selectedTab = controller.listTabs().find((tab) => tab.id === resolved.tabId)
    const previous = portalRegistry.get(target.panelId)
    const changed = name === 'tabSelect'
      ? controller.selectTab(resolved.tabId)
      : controller.closeTab(resolved.tabId)
    if (
      changed
      && name === 'tabSelect'
      && selectedTab?.active !== true
      && !isBrowserInternalPage(selectedTab?.url ?? '')
      && !(await waitForWebview(target.panelId, 8_000, previous))
    ) {
      return { ok: false, error: 'webview-not-ready' }
    }
    return changed
      ? { ok: true, result: { tabId: resolved.tabId } }
      : { ok: false, error: 'no-such-tab' }
  }

  const target = resolveTargetPanelId(workspaceId, args)
  if ('error' in target) return { ok: false, error: target.error }

  if (name === 'viewport') {
    const controller = portalRegistry.getController(target.panelId)
    if (!controller) return { ok: false, error: 'panel-not-mounted' }
    const preset = stringArg(args, 'preset')
    if (preset === 'compact') {
      controller.setViewport({ preset })
      return { ok: true, result: { preset } }
    }
    const width = positiveNumberArg(args, 'width')
    const height = positiveNumberArg(args, 'height')
    if (
      !width
      || !height
      || (preset !== 'desktop' && preset !== 'mobile' && preset !== 'custom')
    ) {
      return { ok: false, error: 'invalid-browser-viewport' }
    }
    controller.setViewport({ preset, width, height })
    return { ok: true, result: { preset, width, height } }
  }

  if (name === 'resize') {
    const width = positiveNumberArg(args, 'width')
    const height = positiveNumberArg(args, 'height')
    if (!width || !height) return { ok: false, error: 'width-and-height-required' }
    const minimum = PANEL_MINIMUM_SIZES.browser
    if (width < minimum.width || height < minimum.height) {
      return {
        ok: false,
        error: `minimum-browser-panel-size-${minimum.width}x${minimum.height}`,
      }
    }
    const location = resolvePanelLocation(workspaceId, target.panelId)
    if (!location) return { ok: false, error: 'panel-not-mounted' }
    if (location.kind !== 'canvas') return { ok: false, error: 'browser-panel-is-docked' }
    const store = getCanvasOpsById(location.canvasPanelId)?.storeApi
    const nodeId = store?.getState().nodeForPanel(target.panelId)
    if (!store || !nodeId) return { ok: false, error: 'panel-not-mounted' }
    store.getState().resizeNode(nodeId, { width, height })
    return { ok: true, result: { panelId: target.panelId, width, height } }
  }

  const webview = portalRegistry.get(target.panelId) ?? await waitForWebview(target.panelId)
  if (!webview) {
    return {
      ok: false,
      error: portalRegistry.getController(target.panelId) ? 'webview-not-ready' : 'panel-not-mounted',
    }
  }

  try {
    if (name === 'reload') {
      webview.reload()
      return { ok: true }
    }
    if (name === 'back' || name === 'forward') {
      const available = name === 'back' ? webview.canGoBack() : webview.canGoForward()
      if (!available) return { ok: false, error: 'no-history' }
      const result = await navigateAndReadUrl(webview, () => name === 'back' ? webview.goBack() : webview.goForward())
      return 'error' in result ? { ok: false, error: result.error } : { ok: true, result }
    }
    if (name === 'current') {
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
    }
    if (name === 'downloads') {
      const response = await control(webview, { op: 'downloads' })
      return response.error
        ? { ok: false, error: response.error }
        : { ok: true, result: { downloads: response.downloads ?? [] } }
    }
    return executeAgentBrowser(webview, target.panelId, name, args)
  } catch {
    return { ok: false, error: 'agent-browser-unavailable' }
  }
}
