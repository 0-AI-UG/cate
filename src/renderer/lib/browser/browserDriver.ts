// Renderer routing for `cate.browser.*`. React owns panel/tab state and each
// BrowserPanel owns its persistent webview. Automation is sent to main with the
// exact active guest id and logical identity; no operation consults DOM focus.

import { useAppStore } from '../../stores/appStore'
import { getActivePanelId } from '../activePanel'
import { portalRegistry, type PortalWebview } from '../portalRegistry'
import { getCanvasOpsById, placementForBackgroundPanel, resolvePanelLocation } from '../workspace/canvasAccess'
import { emitAgentCursor } from './agentCursor'
import { PANEL_MINIMUM_SIZES, type PanelState } from '../../../shared/types'
import { BROWSER_METHODS, BROWSER_ACTION_METHODS } from '../../../shared/browserAutomation'
import type { PanelTargetObserver } from '../panelInteractions'

export type BrowserOutcome = { ok: true; result?: unknown } | { ok: false; error: string; recovery?: string }

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
    if (webview && (previous === undefined || webview !== previous)) {
      // React may have switched the active tab before the previous webview's
      // cleanup removes it from the registry. Only hand callers a guest that
      // Electron still considers attached.
      try {
        webview.getWebContentsId()
        return webview
      } catch { /* wait for the active tab's dom-ready registration */ }
    }
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
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      webview.getWebContentsId()
      if (!webview.isLoading()) return true
    } catch {
      // Tab transitions briefly leave the outgoing DOM node in the registry.
      // It cannot become usable again; let the caller resolve the new guest.
      return false
    }
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
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
  const stillBound = () => currentPanel(workspaceId, panel.id)?.activeTabId === panel.activeTabId && portalRegistry.get(panel.id) === webview
  if (!stillBound()) return { error: 'browser-tab-changed' }
  const target = {
    webContentsId: webview.getWebContentsId(),
    workspaceId,
    panelId: panel.id,
    tabId: panel.activeTabId!,
  }
  const attached = await window.electronAPI.browserControl({ ...target, op: 'attach' })
  if (attached.error) return attached
  if (!stillBound()) return { error: 'browser-tab-changed' }
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

export async function handleBrowserMethod(
  workspaceId: string,
  method: string,
  args: Record<string, unknown>,
  onTargetResolved?: PanelTargetObserver,
): Promise<BrowserOutcome> {
  const name = method.slice('cate.browser.'.length)

  if (!BROWSER_METHODS.has(name)) return { ok: false, error: 'unknown-browser-method' }
  if (name === 'listTabs') {
    const workspace = useAppStore.getState().workspaces.find((item) => item.id === workspaceId)
    const panels = Object.values(workspace?.panels ?? {}).filter((panel) => panel.type === 'browser' && (!args.panelId || panel.id === args.panelId))
    const tabs = panels.flatMap((panel) => (panel.tabs ?? []).map((tab) => ({ ...tab, panelId: panel.id, tabId: tab.id, active: panel.activeTabId === tab.id })))
    return { ok: true, result: { tabs } }
  }
  const initialTarget = resolveTargetPanel(workspaceId, args)
  if (name === 'createTab' && (args.newPanel === true || 'error' in initialTarget && initialTarget.error === 'no-browser')) {
    const created = await createBrowserPanel(workspaceId, stringArg(args, 'url') ?? 'about:blank', args)
    if (created.ok) onTargetResolved?.((created.result as { panelId: string }).panelId)
    return created
  }
  const target = resolveTargetPanel(workspaceId, args)
  if ('error' in target) return { ok: false, error: target.error }
  let panel = target.panel
  if (!panel.activeTabId) return { ok: false, error: 'invalid-browser-tab-state' }
  onTargetResolved?.(panel.id)
  if (name === 'getTab' || name === 'createTab') {
    const controller = await waitForController(panel.id)
    if (!controller) return { ok: false, error: 'panel-not-mounted' }
    const previous = portalRegistry.get(panel.id)
    if (name === 'createTab') controller.newTab(stringArg(args, 'url'))
    else if (args.tabId && args.tabId !== panel.activeTabId) {
      if (!controller.selectTab(String(args.tabId))) return { ok: false, error: 'no-such-tab' }
    }
    const switched = name === 'createTab' || Boolean(args.tabId && args.tabId !== panel.activeTabId)
    const guest = await waitForWebview(panel.id, 8_000, switched ? previous : undefined)
    if (!guest || !await waitForGuestReady(guest)) return { ok: false, error: 'webview-not-ready' }
    panel = currentPanel(workspaceId, panel.id)!
    return { ok: true, result: { panelId: panel.id, tabId: panel.activeTabId, url: guest.getURL(), title: guest.getTitle() } }
  }
  if (typeof args.tabId !== 'string') return { ok: false, error: 'tabId-required' }
  if (args.tabId !== panel.activeTabId) return { ok: false, error: 'browser-tab-changed' }
  if (name === 'close') {
    const controller = await waitForController(panel.id)
    return controller?.closeTab(args.tabId) ? { ok: true, result: { closed: true } } : { ok: false, error: 'no-such-tab' }
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

  if (name === 'setViewport') {
    const preset = stringArg(args, 'preset')
    const width = preset === 'compact' ? 640 : positiveNumberArg(args, 'width')
    const height = preset === 'compact' ? 480 : positiveNumberArg(args, 'height')
    if (!width || !height) return { ok: false, error: 'invalid-browser-viewport' }
    const controller = await waitForController(panel.id)
    if (!controller) return { ok: false, error: 'panel-not-mounted' }
    await waitForGuestReady(webview)
    await controller.setViewport({ preset: preset === 'compact' ? 'compact' : preset === 'mobile' ? 'mobile' : preset === 'desktop' ? 'desktop' : 'custom', width, height } as Parameters<typeof controller.setViewport>[0])
    const response = await control(workspaceId, panel, webview, { op: 'execute', method: 'getAXState', args })
    return response.error ? { ok: false, error: response.error } : { ok: true, result: { preset, width, height, observation: response.result } }
  }

  if (name === 'goto' || name === 'reload' || name === 'back' || name === 'forward' || name === 'downloads') {
    if (name === 'goto') {
      const url = stringArg(args, 'url')
      if (!url) return { ok: false, error: 'url-required' }
      const controller = await waitForController(panel.id)
      if (!controller) return { ok: false, error: 'panel-not-mounted' }
      controller.navigate(url)
    }
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
    await waitForGuestReady(webview)
    const response = await control(workspaceId, panel, webview, { op: 'execute', method: 'getAXState', args: { disableDiffing: true } })
    return response.error ? { ok: false, error: response.error } : { ok: true, result: response.result }
  }

  if (BROWSER_ACTION_METHODS.has(name)) emitAgentCursor(panel.id, {
    kind: name === 'pressKey' ? 'press' : name === 'scroll' ? 'scroll' : 'move', label: name,
  })
  const response = await control(workspaceId, panel, webview, { op: 'execute', method: name, args })
  if (response.error) return { ok: false, error: response.error, recovery: response.recovery }
  if (response.cursor) emitAgentCursor(panel.id, response.cursor)
  return response.result === undefined ? { ok: true } : { ok: true, result: response.result }
}
