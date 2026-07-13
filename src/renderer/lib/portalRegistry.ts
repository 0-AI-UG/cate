// =============================================================================
// portalRegistry — renderer-side map of BrowserPanel <webview> elements.
//
// The main-process orchestrator addresses portals by name (PanelState.title).
// To drive a portal's underlying webContents from main, we need to translate
// panelId → webContentsId. BrowserPanel registers its <webview> here once
// `dom-ready` fires (which is when getWebContentsId() returns a stable id),
// and unregisters on unmount.
//
// Note: refs (the @e1/@e2 mapping returned by `portal snapshot`) live in main
// rather than here — main injects `data-cate-ref` attributes onto the DOM
// during the snapshot and looks them up directly via executeJavaScript() on
// subsequent commands.
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
  /** Real (isTrusted) input delivered to the guest webContents — unlike the
   *  synthetic DOM events click/type dispatch. Used by `browser press`. */
  sendInputEvent(event: { type: 'keyDown' | 'char' | 'keyUp'; keyCode: string }): Promise<void> | void
}

interface Entry {
  webview: PortalWebview
}

const byPanelId = new Map<string, Entry>()

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
} as const
