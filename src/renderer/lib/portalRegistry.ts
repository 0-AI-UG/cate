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

/** Minimal subset of the Electron <webview> tag interface we depend on. */
export interface PortalWebview {
  getWebContentsId(): number
  getURL(): string
  getTitle(): string
  loadURL(url: string): void
}

interface Entry {
  webview: PortalWebview
}

const byPanelId = new Map<string, Entry>()

/** Push a (panelId, webContentsId, alive) tuple to main so it can build a
 *  webContents → portal-panel reverse map. Used by webSecurity's popup
 *  handler to resolve the parent portal name synchronously when a webview
 *  calls window.open(). Non-fatal if main hasn't wired up the listener. */
function pushToMain(panelId: string, webContentsId: number, alive: boolean): void {
  try {
    const ipc = (window as any).electronAPI
    if (!ipc?.orchRegisterPortalWc) return
    ipc.orchRegisterPortalWc({ panelId, webContentsId, alive })
  } catch { /* best effort */ }
}

export const portalRegistry = {
  register(panelId: string, webview: PortalWebview): void {
    byPanelId.set(panelId, { webview })
    let wcId = 0
    try { wcId = webview.getWebContentsId() } catch { /* fine */ }
    if (wcId) pushToMain(panelId, wcId, true)
  },
  unregister(panelId: string): void {
    const entry = byPanelId.get(panelId)
    if (entry) {
      let wcId = 0
      try { wcId = entry.webview.getWebContentsId() } catch { /* fine */ }
      if (wcId) pushToMain(panelId, wcId, false)
    }
    byPanelId.delete(panelId)
  },
  get(panelId: string): PortalWebview | null {
    return byPanelId.get(panelId)?.webview ?? null
  },
} as const
