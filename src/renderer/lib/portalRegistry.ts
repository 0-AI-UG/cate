// =============================================================================
// portalRegistry — renderer-side map of each BrowserPanel's active <webview>.
//
// The main-process orchestrator addresses portals by name (PanelState.title).
// To drive a portal's underlying webContents from main, we need to translate
// panelId → webContentsId. BrowserPanel registers its <webview> here once
// `dom-ready` fires (which is when getWebContentsId() returns a stable id),
// and unregisters on unmount.
//
// Snapshot refs are generation-scoped tokens (for example @s2e4) injected into
// the guest DOM and resolved by browserDriver on subsequent commands.
// =============================================================================

/** Minimal subset of the Electron <webview> tag interface we depend on.
 *  BrowserPanel registers the real <webview> (a superset of this) — these are
 *  the members the reverse-API driver (browserDriver.ts) and terminalUrlOpen
 *  actually call. */
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
    type: 'did-navigate' | 'did-navigate-in-page',
    listener: (event: { url?: string }) => void,
  ): void
  removeEventListener(
    type: 'did-navigate' | 'did-navigate-in-page',
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
 *  lifetime — unlike webviews, which only exist once a page is loaded.
 *
 *  Two things live here that the active <webview> cannot answer:
 *   • navigate() drives a panel sitting on its start page. Such a panel has NO
 *     <webview> (the start page renders in its place), so navigating through
 *     this callback is what mounts one.
 *   • tabs are a PANEL concept: each tab now keeps a live guest, while the tab
 *     list and active-guest selection still live in React state. */
export interface BrowserPanelController {
  navigate(url: string): void
  listTabs(): Array<{ id: string; url: string; title: string; active: boolean }>
  newTab(url?: string): string
  selectTab(tabId: string): boolean
  closeTab(tabId: string): boolean
}

const controllerByPanelId = new Map<string, BrowserPanelController>()

export const portalRegistry = {
  register(panelId: string, webview: PortalWebview): void {
    byPanelId.set(panelId, { webview })
  },
  unregister(panelId: string): void {
    byPanelId.delete(panelId)
  },
  get(panelId: string): PortalWebview | null {
    return byPanelId.get(panelId)?.webview ?? null
  },
  registerController(panelId: string, controller: BrowserPanelController): void {
    controllerByPanelId.set(panelId, controller)
  },
  unregisterController(panelId: string): void {
    controllerByPanelId.delete(panelId)
  },
  getController(panelId: string): BrowserPanelController | null {
    return controllerByPanelId.get(panelId) ?? null
  },
} as const
