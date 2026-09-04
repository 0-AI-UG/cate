// Renderer routing for `cate.browser.*`. React owns panel/tab state and each
// BrowserPanel owns its persistent webview. Automation is sent to main with the
// exact active guest id and logical identity; no operation consults DOM focus.

import { useAppStore } from '../../stores/appStore'
import { getActivePanelId } from '../activePanel'
import { portalRegistry, type PortalWebview } from '../portalRegistry'
import { getCanvasOpsById, placementForBackgroundPanel, resolvePanelLocation } from '../workspace/canvasAccess'
import { emitAgentCursor } from './agentCursor'
import { PANEL_MINIMUM_SIZES, type PanelState } from '../../../shared/types'
import {
  browserActivityLabel,
  browserCommandShowsActivity,
  validateBrowserCommand,
} from '../../../shared/browserCommand'
import type { PanelTargetObserver } from '../panelInteractions'

export type BrowserOutcome = { ok: true; result?: unknown } | { ok: false; error: string }

const ACTING_METHODS = new Set([
  'click', 'dblclick', 'hover', 'fill', 'type', 'press', 'select', 'check',
  'uncheck', 'drag', 'scroll', 'mouse',
])

export function findBrowserPanelId(workspaceId: string): string | null {
  const workspace = useAppStore.getState().workspaces.find((item) => item.id === workspaceId)
  const browsers = Object.values(workspace?.panels ?? {}).filter((panel) => panel.type === 'browser')
  return browsers.length === 1 ? browsers[0].id : null
}

function resolveTargetPanel(workspaceId: string, args: Record<string, unknown>): { panel: PanelState } | { error: string } {
  const workspace = useAppStore.getState().workspaces.find((item) => item.id === workspaceId)
  if (!workspace) return { error: 'workspace-not-found' }
  const explicit = typeof args.panelId === 'string' ? args.panelId : undefined
  if (explicit) {
    const panel = workspace.panels[explicit]
    return panel?.type === 'browser' ? { panel } : { error: 'panel-not-in-window' }
  }
  const placementGroupId = typeof args.placementGroupId === 'string' ? args.placementGroupId : undefined
  if (placementGroupId) {
    const grouped = Object.values(workspace.panels).filter((panel) => panel.type === 'browser' && panel.placementGroupId === placementGroupId)
    return grouped.length === 1 ? { panel: grouped[0] } : { error: grouped.length ? 'browser-target-required' : 'no-browser' }
  }
  const active = getActivePanelId()
  if (active && workspace.panels[active]?.type === 'browser') return { panel: workspace.panels[active] }
  const browsers = Object.values(workspace.panels).filter((panel) => panel.type === 'browser')
  return browsers.length === 1 ? { panel: browsers[0] } : { error: browsers.length ? 'browser-target-required' : 'no-browser' }
}

async function waitForWebview(panelId: string, timeoutMs = 8_000, previous?: PortalWebview | null): Promise<PortalWebview | null> {
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

async function waitForGuestReady(webview: PortalWebview, timeoutMs = 8_000): Promise<boolean> {
  if (!webview.isLoading()) return true
  return new Promise((resolve) => {
    const timer = setTimeout(() => { cleanup(); resolve(false) }, timeoutMs)
    const done = () => { cleanup(); resolve(true) }
    const cleanup = () => {
      clearTimeout(timer)
      webview.removeEventListener('did-stop-loading', done)
    }
    webview.addEventListener('did-stop-loading', done)
    if (!webview.isLoading()) done()
  })
}

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  return typeof args[key] === 'string' ? args[key] as string : undefined
}

function positiveNumberArg(args: Record<string, unknown>, key: string): number | null {
  const value = args[key]
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

async function control(
  workspaceId: string,
  panel: PanelState,
  webview: PortalWebview,
  request: { op: 'execute'; method: string; args: Record<string, unknown> } | { op: 'downloads' },
) {
  const target = {
    webContentsId: webview.getWebContentsId(),
    workspaceId,
    panelId: panel.id,
    tabId: panel.activeTabId!,
  }
  const attached = await window.electronAPI.browserControl({ ...target, op: 'attach' })
  if (attached.error) return attached
  return window.electronAPI.browserControl({ ...target, ...request })
}

function currentPanel(workspaceId: string, panelId: string): PanelState | undefined {
  return useAppStore.getState().workspaces.find((workspace) => workspace.id === workspaceId)?.panels[panelId]
}

async function createBrowserPanel(workspaceId: string, url: string, args: Record<string, unknown>): Promise<BrowserOutcome> {
  const panelId = useAppStore.getState().createBrowser(
    workspaceId, url, undefined,
    placementForBackgroundPanel(workspaceId, stringArg(args, 'placementGroupId')),
  )
  const webview = await waitForWebview(panelId)
  if (!webview) return { ok: false, error: 'panel-not-mounted' }
  await waitForGuestReady(webview)
  return { ok: true, result: { panelId, tabId: currentPanel(workspaceId, panelId)?.activeTabId, url: webview.getURL() || url } }
}

function activityLabel(method: string, args: Record<string, unknown>): string {
  if (method === 'fill' || method === 'type') {
    const clean = String(args.text ?? '').replace(/\s+/g, ' ').trim()
    return `${method} ${JSON.stringify(clean.length > 28 ? `${clean.slice(0, 27)}…` : clean)}`
  }
  return method === 'press' ? `press ${String(args.key ?? '')}`.trim() : method
}

export async function handleBrowserMethod(
  workspaceId: string,
  method: string,
  args: Record<string, unknown>,
  onTargetResolved?: PanelTargetObserver,
): Promise<BrowserOutcome> {
  const name = method.slice('cate.browser.'.length)

  if (name === 'open') {
    const url = stringArg(args, 'url')
    if (!url) return { ok: false, error: 'url-required' }
    if (args.newPanel === true) {
      const created = await createBrowserPanel(workspaceId, url, args)
      if (created.ok && created.result && typeof created.result === 'object') onTargetResolved?.((created.result as { panelId: string }).panelId)
      return created
    }
    const target = resolveTargetPanel(workspaceId, args)
    if ('error' in target) {
      if (target.error === 'no-browser') return createBrowserPanel(workspaceId, url, args)
      return { ok: false, error: target.error }
    }
    onTargetResolved?.(target.panel.id)
    const controller = await waitForController(target.panel.id)
    if (!controller) return { ok: false, error: 'panel-not-mounted' }
    if (args.newTab === true) {
      const previous = portalRegistry.get(target.panel.id)
      const tabId = controller.newTab(url)
      const webview = await waitForWebview(target.panel.id, 8_000, previous)
      if (!webview) return { ok: false, error: 'webview-not-ready' }
      await waitForGuestReady(webview)
      return { ok: true, result: { panelId: target.panel.id, tabId, url: webview.getURL() || url } }
    }
    controller.navigate(url)
    const webview = await waitForWebview(target.panel.id)
    if (!webview) return { ok: false, error: 'webview-not-ready' }
    await waitForGuestReady(webview)
    return { ok: true, result: { panelId: target.panel.id, tabId: target.panel.activeTabId, url: webview.getURL() || url } }
  }

  const target = resolveTargetPanel(workspaceId, args)
  if ('error' in target) return { ok: false, error: target.error }
  const panel = target.panel
  if (!panel.activeTabId) return { ok: false, error: 'invalid-browser-tab-state' }
  onTargetResolved?.(panel.id)

  if (name === 'tabs' || name === 'tabNew' || name === 'tabSelect' || name === 'tabClose') {
    const controller = await waitForController(panel.id)
    if (!controller) return { ok: false, error: 'panel-not-mounted' }
    if (name === 'tabs') return { ok: true, result: { panelId: panel.id, tabs: controller.listTabs() } }
    if (name === 'tabNew') {
      const previous = portalRegistry.get(panel.id)
      const tabId = controller.newTab(stringArg(args, 'url'))
      const webview = await waitForWebview(panel.id, 8_000, previous)
      if (!webview) return { ok: false, error: 'webview-not-ready' }
      await waitForGuestReady(webview)
      return { ok: true, result: { panelId: panel.id, tabId } }
    }
    const tabId = stringArg(args, 'tabId')
    if (!tabId) return { ok: false, error: 'tabId-required' }
    const tabs = controller.listTabs()
    const exact = tabs.find((tab) => tab.id === tabId)
    const matches = exact ? [exact] : tabs.filter((tab) => tab.id.startsWith(tabId))
    if (matches.length !== 1) return { ok: false, error: matches.length ? 'ambiguous-tab' : 'no-such-tab' }
    const ok = name === 'tabSelect' ? controller.selectTab(matches[0].id) : controller.closeTab(matches[0].id)
    if (!ok) return { ok: false, error: 'no-such-tab' }
    if (name === 'tabSelect') {
      const webview = await waitForWebview(panel.id)
      if (webview) await waitForGuestReady(webview)
    }
    return { ok: true, result: { tabId: matches[0].id } }
  }

  if (name === 'resize') {
    const width = positiveNumberArg(args, 'width'), height = positiveNumberArg(args, 'height')
    if (!width || !height) return { ok: false, error: 'width-and-height-required' }
    const minimum = PANEL_MINIMUM_SIZES.browser
    if (width < minimum.width || height < minimum.height) return { ok: false, error: `minimum-browser-panel-size-${minimum.width}x${minimum.height}` }
    const location = resolvePanelLocation(workspaceId, panel.id)
    if (!location) return { ok: false, error: 'panel-not-mounted' }
    if (location.kind !== 'canvas') return { ok: false, error: 'browser-panel-is-docked' }
    const store = getCanvasOpsById(location.canvasPanelId)?.storeApi
    const nodeId = store?.getState().nodeForPanel(panel.id)
    if (!store || !nodeId) return { ok: false, error: 'panel-not-mounted' }
    store.getState().resizeNode(nodeId, { width, height })
    return { ok: true, result: { panelId: panel.id, width, height } }
  }

  const webview = await waitForWebview(panel.id)
  if (!webview) return { ok: false, error: 'webview-not-ready' }

  if (name === 'viewport') {
    const preset = stringArg(args, 'preset')
    const width = preset === 'compact' ? 640 : positiveNumberArg(args, 'width')
    const height = preset === 'compact' ? 480 : positiveNumberArg(args, 'height')
    if (!width || !height) return { ok: false, error: 'invalid-browser-viewport' }
    const controller = await waitForController(panel.id)
    if (!controller) return { ok: false, error: 'panel-not-mounted' }
    await waitForGuestReady(webview)
    await controller.setViewport({ preset: preset === 'compact' ? 'compact' : preset === 'mobile' ? 'mobile' : preset === 'desktop' ? 'desktop' : 'custom', width, height } as Parameters<typeof controller.setViewport>[0])
    return { ok: true, result: { preset, width, height } }
  }

  if (name === 'reload' || name === 'back' || name === 'forward' || name === 'current' || name === 'downloads') {
    if (name === 'reload') webview.reload()
    if (name === 'back') {
      if (!webview.canGoBack()) return { ok: false, error: 'no-history' }
      webview.goBack()
    }
    if (name === 'forward') {
      if (!webview.canGoForward()) return { ok: false, error: 'no-history' }
      webview.goForward()
    }
    if (name === 'downloads') {
      const response = await control(workspaceId, panel, webview, { op: 'downloads' })
      return response.error ? { ok: false, error: response.error } : { ok: true, result: { downloads: response.downloads ?? [] } }
    }
    if (name !== 'current') await waitForGuestReady(webview)
    return { ok: true, result: name === 'current' ? { panelId: panel.id, tabId: panel.activeTabId, url: webview.getURL(), title: webview.getTitle(), loading: webview.isLoading() } : { url: webview.getURL() } }
  }

  let commandActivity: string[] | null = null
  if (name === 'command' || name === 'readCommand') {
    try { commandActivity = validateBrowserCommand(args.command) } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'invalid-browser-command' }
    }
  }
  if (ACTING_METHODS.has(name) || Boolean(commandActivity && browserCommandShowsActivity(commandActivity))) {
    emitAgentCursor(panel.id, {
      kind: name === 'press' ? 'press' : name === 'scroll' ? 'scroll' : 'move',
      label: commandActivity ? browserActivityLabel(commandActivity) : activityLabel(name, args),
    })
  }
  const response = await control(workspaceId, panel, webview, { op: 'execute', method: name, args })
  if (response.error) return { ok: false, error: response.error }
  if (response.cursor) emitAgentCursor(panel.id, response.cursor)
  return response.result === undefined ? { ok: true } : { ok: true, result: response.result }
}
