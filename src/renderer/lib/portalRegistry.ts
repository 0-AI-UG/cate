// =============================================================================
// portalRegistry — renderer-side map of BrowserPanel <webview> elements.
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
export interface PortalWebview {
  getWebContentsId(): number
  getURL(): string
  getTitle(): string
  loadURL(url: string): void
  reload(): void
  isLoading(): boolean
  executeJavaScript(code: string): Promise<unknown>
  /** Real (isTrusted) input delivered to the guest webContents. Browser actions
   *  use this instead of synthetic DOM click/input events. */
  sendInputEvent(event:
    | {
      type: 'keyDown' | 'char' | 'keyUp'
      keyCode: string
      modifiers?: Array<'shift' | 'control' | 'alt' | 'meta'>
    }
    | {
      type: 'mouseMove' | 'mouseDown' | 'mouseUp'
      x: number
      y: number
      button?: 'left'
      clickCount?: number
    }
  ): Promise<void> | void
}

interface Entry {
  webview: PortalWebview
}

const byPanelId = new Map<string, Entry>()

/** Per-panel navigation entry points (BrowserPanel's navigateTo), registered for
 *  the panel's whole mounted lifetime — unlike webviews, which only exist once a
 *  page is loaded. This is how the reverse API drives a browser panel sitting on
 *  its start page: such a panel has NO <webview> (the start page renders in its
 *  place), so navigating through this callback is what mounts one. */
const navigatorByPanelId = new Map<string, (url: string) => void>()

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
  registerNavigator(panelId: string, navigate: (url: string) => void): void {
    navigatorByPanelId.set(panelId, navigate)
  },
  unregisterNavigator(panelId: string): void {
    navigatorByPanelId.delete(panelId)
  },
  getNavigator(panelId: string): ((url: string) => void) | null {
    return navigatorByPanelId.get(panelId) ?? null
  },
} as const
