// The pages of one browser panel on this client: one <webview> per tab. It
// follows the session (loads a tab's URL when its `nav` moves and the change
// came from elsewhere), reports what its own pages do, and runs the runtime's
// page operations for this panel when this client drives it.
//
// Following and reporting: a load this client makes because the session
// changed is never reported back, so two clients whose sessions redirect the
// same URL differently (logged in on one, not the other) cannot ping-pong.
// Only navigation that starts on this client's page (a link, a form, the
// user's back button) moves the session URL.
//
// The tab this client shows is client state (`show`); page operations act on
// the session's active tab, and the driving client shows it while they run.

import { RpcError } from '@kernel/rpc/contract'
import type { BrowserDriverResult, BrowserPageBridge } from '@services/browser/contract'
import type { BrowserOp, BrowserSnapshot, BrowserSurfaceArgs, BrowserSurfaceResult, BrowserTab } from '@panels/browser/contract'
import { pageLoadErrorFrom } from '@panels/browser/contract'
import { createBrowserTabFollower, loadableTabUrl } from '@panels/browser/client'

/** The Electron <webview> element methods the view uses. */
export interface BrowserGuest extends HTMLElement {
  loadURL(url: string): Promise<void> | void
  goBack(): void
  goForward(): void
  reload(): void
  reloadIgnoringCache(): void
  canGoBack(): boolean
  canGoForward(): boolean
  isLoading(): boolean
  getURL(): string
  getTitle(): string
  getWebContentsId(): number
  insertCSS(css: string): Promise<string>
  getZoomFactor(): number
  setZoomFactor(factor: number): void
  focus(): void
}

/** What this client's page of the shown tab shows, for the toolbar. */
interface LocalPageState {
  url: string
  canGoBack: boolean
  canGoForward: boolean
  isLoading: boolean
  loadError: string | null
  crashed: boolean
}

/** Saved-password suggestions for the focused field of the shown page. */
interface BrowserAutofill {
  targetId: string
  rect: { left: number; bottom: number; width: number; height: number }
  suggestions: Array<{ id: string; username: string; origin: string }>
}

interface Page {
  webview: BrowserGuest
  ready: boolean
  /** A URL to load once the guest is ready. */
  pending: string | null
  detach(): void
}

interface PageHostDeps {
  panelId: string
  clientId: string
  send(op: BrowserOp): Promise<unknown>
  /** Shows a tab on this client (a page operation runs on it). */
  reveal?(tabId: string): void
  bridge: BrowserPageBridge | null
  /** Saved passwords and file uploads come from the runtime. */
  passwords?: {
    suggestions(url: string): Promise<BrowserAutofill['suggestions']>
    forFill(id: string, url: string): Promise<{ username: string; password: string } | null>
    saveDisposition(input: PasswordSubmit): Promise<'create' | 'update' | 'unchanged'>
    save(input: PasswordSubmit): Promise<unknown>
  }
  /** Asks the user whether to save a submitted password. */
  confirmSave?(message: string): Promise<boolean>
  /** Moves a runtime file to this client for a file input. */
  fetchUpload?(path: string): Promise<{ name: string; bytes: Uint8Array }>
  /** Guest scrollbar CSS matching the theme. */
  guestCss?(): string
  nextFrame?(): Promise<void>
}

interface PasswordSubmit {
  origin: string
  username: string
  password: string
  usernameElement?: string
  passwordElement?: string
}

const loadable = loadableTabUrl
const defaultFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

export class BrowserPageHost {
  private readonly pages = new Map<string, Page>()
  /** Which tabs follow the session (the core's tab follower). */
  private readonly follower = createBrowserTabFollower(() => this.deps.clientId)
  private readonly listeners = new Set<() => void>()
  private readonly waiters = new Set<() => void>()
  private snapshot: BrowserSnapshot | null = null
  /** The tab this client shows. */
  private shown: string | undefined
  /** This client's page zoom (client state, not the session's). */
  private zoom = 1
  private disposed = false
  private revision = 0
  private autofillRequest = 0
  private filling = false
  private savePrompt = false
  visible = false
  local: LocalPageState = { url: '', canGoBack: false, canGoForward: false, isLoading: false, loadError: null, crashed: false }
  autofill: BrowserAutofill | null = null

  constructor(private readonly deps: PageHostDeps) {}

  get panelId(): string { return this.deps.panelId }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Changes on every local change, for `useSyncExternalStore`. */
  getVersion = (): number => this.revision

  private changed(): void {
    this.revision++
    for (const listener of [...this.listeners]) listener()
    for (const check of [...this.waiters]) check()
  }

  /** The tab this client shows. */
  private get shownTabId(): string | undefined {
    return this.shown ?? this.snapshot?.activeTabId
  }

  /** The view tells which tab this client shows. */
  show(tabId: string): void {
    if (tabId === this.shown) return
    this.shown = tabId
    this.dismissAutofill()
    this.refreshLocal()
  }

  private tab(tabId: string): BrowserTab | undefined {
    return this.snapshot?.tabs.find((tab) => tab.id === tabId)
  }

  // ---- Following the session ----------------------------------------------

  /** The `src` a tab's webview mounts with; it stays fixed so a re-render never reloads. */
  seedFor(tab: BrowserTab): string {
    return loadable(tab.url) ? tab.url : 'about:blank'
  }

  update(snapshot: BrowserSnapshot): void {
    this.snapshot = snapshot
    for (const { tabId, url } of this.follower.toFollow(snapshot)) {
      const page = this.pages.get(tabId)
      let current = ''
      try { current = page?.ready ? page.webview.getURL() : '' } catch { /* detached */ }
      // No page yet (it mounts on the tab's URL), or it is there already.
      if (!page || current === url) {
        this.follower.loadEnded(tabId)
        continue
      }
      this.follow(page, url)
    }
    for (const check of [...this.waiters]) check()
  }

  private follow(page: Page, url: string): void {
    if (!page.ready) {
      page.pending = url
      return
    }
    try {
      void Promise.resolve(page.webview.loadURL(url)).catch(() => { /* reported by did-fail-load */ })
    } catch { /* detached */ }
  }

  // ---- Guests ---------------------------------------------------------------

  /** The view hands over each tab's <webview> (null on unmount). */
  attachGuest(tabId: string, webview: BrowserGuest | null): void {
    const previous = this.pages.get(tabId)
    if (previous?.webview === webview) return
    previous?.detach()
    this.pages.delete(tabId)
    if (webview && !this.disposed) {
      const page: Page = { webview, ready: false, pending: null, detach: () => {} }
      page.detach = this.listen(tabId, page)
      this.pages.set(tabId, page)
    }
    this.changed()
  }

  private guestRef(tabId: string, page: Page) {
    return { webContentsId: page.webview.getWebContentsId(), panelId: this.panelId, tabId }
  }

  private listen(tabId: string, page: Page): () => void {
    const { webview } = page
    const active = () => tabId === this.shownTabId
    const report = (op: BrowserOp) => { void this.deps.send(op).catch(() => { /* the panel went away */ }) }
    const reportLoad = (patch: { loading?: boolean; loadError?: string; crashed?: boolean }) => {
      const op = this.follower.load(tabId, patch)
      if (active() && this.visible) report(op)
    }
    const handlers: Record<string, (event: any) => void> = {
      'dom-ready': () => {
        try { webview.getWebContentsId() } catch { return }
        const first = !page.ready
        page.ready = true
        try { webview.setZoomFactor(this.zoom) } catch { /* detached */ }
        const css = this.deps.guestCss?.()
        if (css) void webview.insertCSS(css).catch(() => { /* guest gone */ })
        if (this.deps.bridge) void this.deps.bridge.attach(this.guestRef(tabId, page)).catch(() => { /* retried on next dom-ready */ })
        if (first && page.pending) {
          const url = page.pending
          page.pending = null
          this.follow(page, url)
        }
      },
      'did-navigate': (event) => this.navigated(tabId, page, event.url, false),
      'did-navigate-in-page': (event) => { if (event.isMainFrame !== false) this.navigated(tabId, page, event.url, true) },
      'page-title-updated': (event) => {
        const title = event.title ?? webview.getTitle()
        if (title) report({ kind: 'reportTitle', tabId, title })
      },
      'page-favicon-updated': (event) => {
        const favicon = Array.isArray(event.favicons) ? event.favicons[0] : undefined
        if (typeof favicon === 'string') report({ kind: 'reportFavicon', tabId, favicon })
      },
      // Only main-frame failures are page errors; subframe and aborted loads are not.
      'did-fail-load': (event) => {
        const loadError = pageLoadErrorFrom(event)
        if (loadError === null) return
        if (active()) this.setLocal({ loadError, isLoading: false })
        reportLoad({ loadError })
      },
      'did-start-loading': () => {
        if (active()) {
          this.setLocal({ isLoading: true, loadError: null, crashed: false })
          this.dismissAutofill()
        }
        reportLoad({ loading: true })
      },
      'did-stop-loading': () => {
        if (active()) this.setLocal({ isLoading: false })
        reportLoad({ loading: false })
      },
      'render-process-gone': (event) => {
        if ((event?.reason ?? 'crashed') === 'clean-exit') return
        if (active()) this.setLocal({ crashed: true, isLoading: false })
        reportLoad({ crashed: true })
      },
      'ipc-message': (event) => {
        if (active()) void this.guestMessage(page, event)
      },
    }
    // Every guest event may settle a readiness wait.
    const listeners = Object.entries(handlers).map(([type, handler]) => [type, (event: unknown) => {
      handler(event)
      this.changed()
    }] as const)
    for (const [type, listener] of listeners) webview.addEventListener(type, listener)
    return () => { for (const [type, listener] of listeners) webview.removeEventListener(type, listener) }
  }

  private navigated(tabId: string, page: Page, eventUrl: string | undefined, inPage: boolean): void {
    let url = eventUrl ?? ''
    try { url ||= page.webview.getURL() } catch { return }
    let canGoBack = false
    let canGoForward = false
    let title = ''
    try {
      canGoBack = page.webview.canGoBack()
      canGoForward = page.webview.canGoForward()
      title = page.webview.getTitle()
    } catch { /* detached */ }
    const op = this.follower.report(tabId, { url, title, inPage, canGoBack, canGoForward })
    if (!op) return
    if (tabId === this.shownTabId) {
      this.setLocal({ url, canGoBack, canGoForward, ...(inPage ? {} : { isLoading: false, loadError: null }) })
    }
    void this.deps.send(op).catch(() => { /* the panel went away */ })
  }

  private setLocal(patch: Partial<LocalPageState>): void {
    this.local = { ...this.local, ...patch }
    this.changed()
  }

  /** Re-reads the shown page's state (after a tab switch). */
  refreshLocal(): void {
    const tabId = this.shownTabId
    const tab = tabId ? this.tab(tabId) : undefined
    const page = tabId ? this.pages.get(tabId) : undefined
    let state: LocalPageState = { url: tab?.url ?? '', canGoBack: false, canGoForward: false, isLoading: false, loadError: null, crashed: false }
    if (page?.ready && tab && loadable(tab.url)) {
      try {
        state = {
          ...state,
          url: page.webview.getURL() || tab.url,
          canGoBack: page.webview.canGoBack(),
          canGoForward: page.webview.canGoForward(),
          isLoading: page.webview.isLoading(),
        }
      } catch { /* detached */ }
    }
    this.local = state
    this.changed()
  }

  /** The shown tab's page URL on this client, else the session's. */
  displayUrl(): string {
    const tab = this.shownTabId ? this.tab(this.shownTabId) : undefined
    if (!tab) return ''
    if (!loadable(tab.url)) return tab.url
    return this.local.url || tab.url
  }

  applyZoom(zoom: number): void {
    this.zoom = zoom
    for (const page of this.pages.values()) {
      try { page.webview.setZoomFactor(zoom) } catch { /* not ready */ }
    }
  }

  webview(tabId = this.shownTabId): BrowserGuest | null {
    return (tabId && this.pages.get(tabId)?.webview) || null
  }

  // ---- This client's own page actions (toolbar) ---------------------------

  /** Back, forward or reload on this client's page. False without history. */
  historyAction(action: 'back' | 'forward' | 'reload' | 'reloadHard', tabId = this.shownTabId): boolean {
    const page = tabId ? this.pages.get(tabId) : undefined
    if (!page?.ready) return false
    const { webview } = page
    try {
      if (action === 'back') {
        if (!webview.canGoBack()) return false
        webview.goBack()
      } else if (action === 'forward') {
        if (!webview.canGoForward()) return false
        webview.goForward()
      } else if (action === 'reloadHard') {
        webview.reloadIgnoringCache()
      } else {
        webview.reload()
      }
      return true
    } catch {
      return false
    }
  }

  // ---- Page operations (surface requests) ---------------------------------

  /** The page of `tabId`, still the session's active tab and shown here. */
  private requireActive(tabId: string): Page {
    if (tabId !== this.snapshot?.activeTabId || tabId !== this.shownTabId) throw new Error('browser-tab-changed')
    const page = this.pages.get(tabId)
    if (!page) throw new Error('webview-not-ready')
    return page
  }

  /** Shows the session's active tab `tabId` on this client for a page
   *  operation, then returns its page. */
  private async drive(tabId: string): Promise<Page> {
    if (tabId !== this.snapshot?.activeTabId) throw new Error('browser-tab-changed')
    if (this.shownTabId !== tabId) {
      this.deps.reveal?.(tabId)
      await this.waitFor(() => (this.shownTabId === tabId ? true : undefined), 2_000)
      const frame = this.deps.nextFrame ?? defaultFrame
      await frame()
      await frame()
    }
    return this.requireActive(tabId)
  }

  /** Resolves when `check` returns non-undefined, rechecked on every page change. */
  private waitFor<T>(check: () => T | undefined, timeoutMs: number): Promise<T | undefined> {
    return new Promise((resolve) => {
      const run = () => {
        let value: T | undefined
        try { value = this.disposed ? (null as T) : check() } catch { value = undefined }
        if (value === undefined) return
        clearTimeout(timer)
        this.waiters.delete(run)
        resolve(this.disposed ? undefined : value)
      }
      const timer = setTimeout(() => {
        this.waiters.delete(run)
        resolve(undefined)
      }, timeoutMs)
      this.waiters.add(run)
      run()
    })
  }

  private info(page: Page): { url: string; title: string } {
    return { url: page.webview.getURL(), title: page.webview.getTitle() }
  }

  async ready(args: BrowserSurfaceArgs<'page.ready'>): Promise<BrowserSurfaceResult<'page.ready'>> {
    const { tabId, nav } = args
    // A tab's page mounts once this client shows it.
    if (!this.pages.has(tabId) && tabId === this.snapshot?.activeTabId) this.deps.reveal?.(tabId)
    const settled = await this.waitFor(() => {
      const page = this.pages.get(tabId)
      if (!page?.ready || (this.follower.seenNav(tabId) ?? 0) < nav || page.pending) return undefined
      page.webview.getWebContentsId()
      return page.webview.isLoading() ? undefined : this.info(page)
    }, args.timeoutMs ?? 8_000)
    if (settled) return settled
    const page = this.pages.get(tabId)
    if (!page?.ready) throw new Error('webview-not-ready')
    return this.info(page)
  }

  async history(args: BrowserSurfaceArgs<'page.history'>): Promise<BrowserSurfaceResult<'page.history'>> {
    await this.drive(args.tabId)
    return { ok: this.historyAction(args.action, args.tabId) }
  }

  async execute(args: BrowserSurfaceArgs<'page.execute'>): Promise<BrowserDriverResult> {
    const { bridge } = this.deps
    if (!bridge) throw new RpcError('no-renderer', 'this client has no page driver')
    const page = await this.drive(args.tabId)
    if (args.settle) {
      const frame = this.deps.nextFrame ?? defaultFrame
      await frame()
      await frame()
    }
    const ready = await this.waitFor(() => (page.ready ? true : undefined), 8_000)
    if (!ready) throw new Error('webview-not-ready')
    this.requireActive(args.tabId)
    let methodArgs = args.args
    if (args.method === 'upload' && typeof methodArgs.filePath === 'string') {
      if (!this.deps.fetchUpload) throw new Error('browser-upload-unavailable')
      const file = await this.deps.fetchUpload(methodArgs.filePath)
      methodArgs = { ...methodArgs, filePath: await bridge.stageUpload(file.name, file.bytes) }
    }
    const guest = this.guestRef(args.tabId, page)
    await bridge.attach(guest)
    this.requireActive(args.tabId)
    return bridge.execute(guest, args.method, methodArgs)
  }

  async download(args: BrowserSurfaceArgs<'page.download'>): Promise<BrowserSurfaceResult<'page.download'>> {
    const { bridge } = this.deps
    if (!bridge) throw new RpcError('no-renderer', 'this client has no page driver')
    const page = await this.drive(args.tabId)
    if (!page.ready) throw new Error('webview-not-ready')
    await bridge.download(this.guestRef(args.tabId, page), args.url)
    return { url: args.url }
  }

  /** The tab a download's guest belongs to. */
  tabForGuest(webContentsId: number): string | undefined {
    for (const [tabId, page] of this.pages) {
      try { if (page.webview.getWebContentsId() === webContentsId) return tabId } catch { /* unattached */ }
    }
    return undefined
  }

  // ---- Passwords --------------------------------------------------------------

  private async guestMessage(page: Page, event: { channel?: string; args?: unknown[] }): Promise<void> {
    if (event?.channel === 'cate-browser-password-focus') await this.autofillRequested(page, event.args?.[0])
    else if (event?.channel === 'cate-browser-password-submit') await this.offerToSave(event.args?.[0])
  }

  /** The page's bridge reports a focused password field. */
  private async autofillRequested(page: Page, payload: unknown): Promise<void> {
    const request = ++this.autofillRequest
    if (this.filling || !this.deps.passwords) return
    const focus = payload as (Partial<BrowserAutofill> & { dismiss?: boolean }) | undefined
    if (focus?.dismiss) return this.dismissAutofill()
    const rect = focus?.rect
    if (!focus || typeof focus.targetId !== 'string' || !rect || ![rect.left, rect.bottom, rect.width, rect.height].every(Number.isFinite)) return
    let url: string
    try { url = page.webview.getURL() } catch { return }
    try {
      const suggestions = await this.deps.passwords.suggestions(url)
      if (request !== this.autofillRequest || this.filling) return
      const current = this.shownTabId ? this.pages.get(this.shownTabId) === page : false
      this.autofill = current && suggestions.length ? { targetId: focus.targetId, rect, suggestions } : null
    } catch {
      if (request === this.autofillRequest) this.autofill = null
    }
    this.changed()
  }

  dismissAutofill(): void {
    this.autofillRequest++
    if (!this.autofill) return
    this.autofill = null
    this.changed()
  }

  /** The password comes from the runtime and goes straight to the page. */
  async fillCredential(credentialId: string): Promise<void> {
    const popup = this.autofill
    const page = this.shownTabId ? this.pages.get(this.shownTabId) : undefined
    this.autofill = null
    this.changed()
    if (!popup || !page || !this.deps.passwords || !this.deps.bridge) return
    this.filling = true
    try {
      const url = page.webview.getURL()
      const credential = await this.deps.passwords.forFill(credentialId, url)
      if (!credential) return
      await this.deps.bridge.fillCredential(page.webview.getWebContentsId(), popup.targetId, credential)
    } finally {
      this.filling = false
    }
  }

  private async offerToSave(payload: unknown): Promise<void> {
    const passwords = this.deps.passwords
    if (!passwords || !this.deps.confirmSave || this.savePrompt || !payload || typeof payload !== 'object') return
    const raw = payload as Record<string, unknown>
    const input: PasswordSubmit = {
      origin: typeof raw.origin === 'string' ? raw.origin : '',
      username: typeof raw.username === 'string' ? raw.username : '',
      password: typeof raw.password === 'string' ? raw.password : '',
      usernameElement: typeof raw.usernameElement === 'string' ? raw.usernameElement : '',
      passwordElement: typeof raw.passwordElement === 'string' ? raw.passwordElement : '',
    }
    if (!input.origin || !input.password) return
    this.savePrompt = true
    try {
      const action = await passwords.saveDisposition(input)
      if (action === 'unchanged') return
      const host = new URL(input.origin).hostname
      const who = input.username || 'No username'
      const agent = raw.automated === true ? ' (entered by an agent)' : ''
      const question = action === 'update'
        ? `Update the saved password for ${host} (${who})${agent}?`
        : `Save the password for ${host} (${who})${agent}?`
      if (await this.deps.confirmSave(question)) await passwords.save(input)
    } catch {
      // A failed save is not worth interrupting the page for.
    } finally {
      this.savePrompt = false
    }
  }

  dispose(): void {
    this.disposed = true
    for (const page of this.pages.values()) page.detach()
    this.pages.clear()
    for (const check of [...this.waiters]) check()
    this.waiters.clear()
    this.listeners.clear()
  }
}
