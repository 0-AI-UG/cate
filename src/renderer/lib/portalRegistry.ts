// =============================================================================
// portalRegistry — renderer-side map of each BrowserPanel's active browser view.
//
// The main-process orchestrator addresses portals by name (PanelState.title).
// To drive a portal's underlying webContents from main, we need to translate
// panelId → webContentsId. BrowserPanel registers its view here once
// `dom-ready` fires (which is when getWebContentsId() returns a stable id),
// and unregisters on unmount.
//
// Snapshot refs are generation-scoped tokens (for example @s2e4) resolved by
// the target-bound main-process runtime on subsequent commands.
// =============================================================================

/** Minimal subset of the DOM <webview> surface that browser automation uses. */
export type PortalInputModifier = 'shift' | 'control' | 'alt' | 'meta'

export type PortalInputEvent =
  | {
    type: 'keyDown' | 'char' | 'keyUp'
    keyCode: string
    modifiers?: PortalInputModifier[]
  }
  | {
    type: 'mouseMove' | 'mouseDown' | 'mouseUp' | 'mouseEnter' | 'mouseLeave'
    x: number
    y: number
    button?: 'left' | 'middle' | 'right'
    clickCount?: number
    modifiers?: PortalInputModifier[]
  }
  | {
    // Wheel scrolling. Electron requires the click/position fields on the
    // wheel event too; deltaX/deltaY carry the scroll amount in CSS pixels.
    type: 'mouseWheel'
    x: number
    y: number
    deltaX?: number
    deltaY?: number
    modifiers?: PortalInputModifier[]
  }

export interface PortalWebview {
  getWebContentsId(): number
  getURL(): string
  getTitle(): string
  loadURL(url: string): void
  reload(): void
  isLoading(): boolean
  goBack(): void
  goForward(): void
  canGoBack(): boolean
  canGoForward(): boolean
  addEventListener(
    type: 'did-navigate' | 'did-navigate-in-page' | 'did-stop-loading',
    listener: (event: { url?: string }) => void,
  ): void
  removeEventListener(
    type: 'did-navigate' | 'did-navigate-in-page' | 'did-stop-loading',
    listener: (event: { url?: string }) => void,
  ): void
  executeJavaScript(code: string): Promise<unknown>
  /** Real (isTrusted) input delivered to the guest webContents. Browser actions
   *  use this instead of synthetic DOM click/input events. */
  sendInputEvent(event: PortalInputEvent): Promise<void> | void
}

interface Entry {
  webview: PortalWebview
}

const byPanelId = new Map<string, Entry>()

/** Panel-level control surface, registered for a BrowserPanel's whole mounted
 *  lifetime — unlike browser views, which only exist once a page is loaded.
 *
 *  Navigation and tabs are panel concepts; the active guest and light tab list
 *  live in React. */
export interface BrowserPanelController {
  navigate(url: string): void
  listTabs(): Array<{ id: string; url: string; title: string; active: boolean }>
  newTab(url?: string): string
  selectTab(tabId: string): boolean
  closeTab(tabId: string): boolean
  setViewport(viewport: BrowserViewport): Promise<void>
}

export type BrowserViewport =
  | { preset: 'compact' }
  | { preset: 'desktop' | 'mobile' | 'custom'; width: number; height: number }

const controllerByPanelId = new Map<string, BrowserPanelController>()

export const portalRegistry = {
  register(panelId: string, webview: PortalWebview): void {
    byPanelId.set(panelId, { webview })
  },
  unregister(panelId: string, webview?: PortalWebview): void {
    if (!webview || byPanelId.get(panelId)?.webview === webview) byPanelId.delete(panelId)
  },
  get(panelId: string): PortalWebview | null {
    return byPanelId.get(panelId)?.webview ?? null
  },
  registerController(panelId: string, controller: BrowserPanelController): void {
    controllerByPanelId.set(panelId, controller)
  },
  unregisterController(panelId: string, controller?: BrowserPanelController): void {
    if (!controller || controllerByPanelId.get(panelId) === controller) {
      controllerByPanelId.delete(panelId)
    }
  },
  getController(panelId: string): BrowserPanelController | null {
    return controllerByPanelId.get(panelId) ?? null
  },
} as const
