import type {
  BrowserViewEvent,
  BrowserViewState,
} from '../../../shared/electron-api'
import type {
  PortalInputEvent,
  PortalWebview,
} from '../portalRegistry'

type Listener = (event: any) => void

const proxies = new Map<number, NativeBrowserView>()
let listening = false

function ensureEventBridge(): void {
  if (listening) return
  listening = true
  window.electronAPI.onBrowserViewEvent((event) => {
    proxies.get(event.webContentsId)?.accept(event)
  })
}

/** Renderer-side compatibility facade for the old Electron <webview> methods.
 *  Browser drivers keep using the same narrow PortalWebview contract while the
 *  actual WebContents is owned and positioned by main. */
export class NativeBrowserView implements PortalWebview {
  private state: BrowserViewState
  private readonly listeners = new Map<string, Set<Listener>>()

  private constructor(
    readonly panelId: string,
    initial: BrowserViewState,
  ) {
    this.state = initial
  }

  static async create(panelId: string, partition: string): Promise<NativeBrowserView | null> {
    ensureEventBridge()
    const initial = await window.electronAPI.browserViewCreate({ panelId, partition })
    if (!initial) return null
    const proxy = new NativeBrowserView(panelId, initial)
    proxies.set(initial.webContentsId, proxy)
    return proxy
  }

  dispose(): void {
    if (proxies.get(this.state.webContentsId) === this) proxies.delete(this.state.webContentsId)
    void window.electronAPI.browserViewDestroy(this.panelId, this.state.webContentsId)
    this.listeners.clear()
  }

  accept(event: BrowserViewEvent): void {
    if (event.state) this.state = event.state
    switch (event.type) {
      case 'did-navigate':
      case 'did-navigate-in-page':
        if (event.url) this.state.url = event.url
        break
      case 'page-title-updated':
        if (event.title) this.state.title = event.title
        break
      case 'did-start-loading':
        this.state.loading = true
        break
      case 'did-stop-loading':
      case 'did-fail-load':
        this.state.loading = false
        break
    }
    const payload = event.type === 'password-focus'
      ? { channel: 'cate-browser-password-focus', args: [event.payload] }
      : event
    this.emit(event.type === 'password-focus' ? 'ipc-message' : event.type, payload)
    if (!event.state && (event.type === 'did-navigate' || event.type === 'did-navigate-in-page')) {
      void this.refreshState()
    }
  }

  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }

  private command(command: Parameters<typeof window.electronAPI.browserViewCommand>[2]): Promise<unknown> {
    return window.electronAPI.browserViewCommand(this.panelId, this.state.webContentsId, command)
  }

  private async refreshState(): Promise<void> {
    const next = await this.command({ op: 'getState' }) as BrowserViewState | null
    if (next) this.state = next
  }

  getWebContentsId(): number { return this.state.webContentsId }
  getURL(): string { return this.state.url }
  getTitle(): string { return this.state.title }
  isLoading(): boolean { return this.state.loading }
  canGoBack(): boolean { return this.state.canGoBack }
  canGoForward(): boolean { return this.state.canGoForward }
  loadURL(url: string): void { void this.command({ op: 'loadURL', url }).catch(() => {}) }
  reload(): void { void this.command({ op: 'reload' }) }
  reloadIgnoringCache(): void { void this.command({ op: 'reloadIgnoringCache' }) }
  goBack(): void { void this.command({ op: 'goBack' }) }
  goForward(): void { void this.command({ op: 'goForward' }) }
  focus(): void { void this.command({ op: 'focus' }) }
  executeJavaScript(code: string): Promise<unknown> {
    return this.command({ op: 'executeJavaScript', code })
  }
  sendInputEvent(event: PortalInputEvent): Promise<void> {
    return this.command({ op: 'sendInputEvent', event: event as any }).then(() => {})
  }
  capturePage(): Promise<string | null> {
    return this.command({ op: 'capturePage' }) as Promise<string | null>
  }
  setLayout(layout: Parameters<typeof window.electronAPI.browserViewSetBounds>[2]): void {
    window.electronAPI.browserViewSetBounds(this.panelId, this.state.webContentsId, layout)
  }
  addEventListener(type: string, listener: Listener): void {
    const set = this.listeners.get(type) ?? new Set<Listener>()
    set.add(listener)
    this.listeners.set(type, set)
  }
  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener)
  }
}
