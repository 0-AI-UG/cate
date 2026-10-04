// The browser panel session (architecture 10.2, 11.2). Holds tabs, URLs,
// titles, navigation state, viewport and the downloads list; every
// client loads the page itself and follows the session URL. Page operations
// (`cate.browser.*` page methods, palette history commands) run on the
// driving client through `withSurface`.

import { sessionApi, type ApiSessionContext } from '@kernel/api/contract'
import { RpcError } from '@kernel/rpc/contract'
import {
  BROWSER_ACTION_METHODS,
  BROWSER_NEW_TAB_URL,
  isRecordableBrowserUrl,
  type BrowserDownloadEntry,
  type BrowserDriverResult,
} from '@services/browser/contract'
import type { BrowserNewTabBehavior, BrowserSearchEngine } from '@services/browser/contract/settings'
import { isCanvasDock, placementOf, type Json, type PanelRecord } from '@workspace/document/contract'
import { PanelSession, type OpContext, type OpHandlers, type PanelSessionClass, type SessionKit } from '@panels/framework/runtime'
import {
  COMPACT_VIEWPORT,
  browserApi,
  type AgentCursorEvent,
  type AgentCursorKind,
  type BrowserDownload,
  type BrowserOp,
  type BrowserSnapshot,
  type BrowserSurfaceArgs,
  type BrowserSurfaceOp,
  type BrowserSurfaceResult,
  type BrowserTab,
  type BrowserViewport,
} from './contract'
import definition from './definition'
import { filePathOfUrl, resolveAddress } from './contract/browserUrl'
import { browserInternalPageTitle, isBrowserInternalPage } from './contract/internalPages'

/** What the session takes from the runtime (the composition root passes them). */
export interface BrowserSessionDeps {
  /** The workspace's browser data (`services/browser/runtime`). */
  browserData: {
    history: { recordVisit(url: string, title: string): void }
    downloads: {
      list(panelId: string): BrowserDownloadEntry[]
      subscribe(panelId: string, cb: (entries: BrowserDownloadEntry[]) => void): () => void
    }
  }
  /** Workspace settings: `browserSearchEngine`, `browserNewTabBehavior`, `browserHomepage`. */
  settings: { get(key: string): unknown }
  /** The workspace's files: a typed path or `file://` URL loads the
   *  workspace's file through `serveUrl`, never the client's disk. */
  files: { serveUrl(path: string): Promise<string> }
  newId?: () => string
}

type Persisted = {
  tabs: Array<{ id: string; url: string; title: string; favicon: string | null; pinned: boolean }>
  activeTabId: string
  viewport: BrowserViewport
}

const isStartPage = (url: string) => url === BROWSER_NEW_TAB_URL
const hasPage = (url: string) => !isStartPage(url) && !isBrowserInternalPage(url)
const changed = (message: string) => new RpcError('rejected', message)

function cursorKind(method: string): AgentCursorKind {
  if (method === 'setValue' || method === 'typeText') return 'type'
  if (method === 'pressKey') return 'press'
  if (method === 'scroll') return 'scroll'
  return 'move'
}

function validViewport(value: unknown): value is BrowserViewport {
  if (!value || typeof value !== 'object') return false
  const viewport = value as Record<string, unknown>
  if (viewport.preset === 'compact') return true
  return ['desktop', 'mobile', 'custom'].includes(String(viewport.preset))
    && typeof viewport.width === 'number' && viewport.width > 0
    && typeof viewport.height === 'number' && viewport.height > 0
}

export class BrowserSession extends PanelSession<BrowserSnapshot, BrowserOp> {
  private stopDownloads: (() => void) | undefined
  private readonly newId: () => string

  constructor(kit: SessionKit, record: PanelRecord, private readonly deps: BrowserSessionDeps) {
    const id = `tab-${(deps.newId ?? (() => globalThis.crypto.randomUUID()))()}`
    const url = typeof record.fields.url === 'string' && record.fields.url ? record.fields.url : BROWSER_NEW_TAB_URL
    super(kit, record, {
      tabs: [{ id, url, title: browserInternalPageTitle(url), favicon: null, pinned: false, nav: 0, navSource: null }],
      activeTabId: id,
      activeSource: null,
      viewport: COMPACT_VIEWPORT,
      canGoBack: false,
      canGoForward: false,
      isLoading: hasPage(url),
      loadError: null,
      crashed: false,
      downloads: [],
      agentCursor: null,
    })
    this.newId = deps.newId ?? (() => globalThis.crypto.randomUUID())
  }

  override async start(): Promise<void> {
    const saved = this.persisted<Persisted>()
    if (saved && Array.isArray(saved.tabs) && saved.tabs.length > 0) {
      const tabs = saved.tabs.map((tab): BrowserTab => ({
        id: String(tab.id),
        url: String(tab.url),
        title: String(tab.title ?? ''),
        favicon: typeof tab.favicon === 'string' ? tab.favicon : null,
        pinned: tab.pinned === true,
        nav: 0,
        navSource: null,
      }))
      const activeTabId = tabs.some((tab) => tab.id === saved.activeTabId) ? saved.activeTabId : tabs[0].id
      const active = tabs.find((tab) => tab.id === activeTabId)!
      this.publish({
        tabs,
        activeTabId,
        viewport: validViewport(saved.viewport) ? saved.viewport : COMPACT_VIEWPORT,
        isLoading: hasPage(active.url),
      })
    }
    const panelId = this.panelId
    this.publishDownloads(this.deps.browserData.downloads.list(panelId))
    this.stopDownloads = this.deps.browserData.downloads.subscribe(panelId, (entries) => this.publishDownloads(entries))
    // A panel created on a file URL loads it from the workspace's file server.
    const first = this.activeTab
    if (!saved && filePathOfUrl(first.url)) {
      try {
        await this.navigateTab(first.id, first.url)
      } catch (err) {
        this.kit.log.warn('browser %s: could not serve %s: %O', panelId, first.url, err)
      }
    }
  }

  protected override release(): void {
    this.stopDownloads?.()
    this.stopDownloads = undefined
  }

  // ---- State ---------------------------------------------------------------

  private get activeTab(): BrowserTab {
    return this.state.tabs.find((tab) => tab.id === this.state.activeTabId)!
  }

  private tab(tabId: string): BrowserTab {
    const tab = this.state.tabs.find((candidate) => candidate.id === tabId)
    if (!tab) throw new RpcError('gone', 'no-such-tab')
    return tab
  }

  private save(): void {
    const { tabs, activeTabId, viewport } = this.state
    this.persist({
      tabs: tabs.map(({ id, url, title, favicon, pinned }) => ({ id, url, title, favicon, pinned })),
      activeTabId,
      viewport,
    } as unknown as Json)
  }

  /** The record carries the active page's title and URL, for the tab title,
   *  the palette and other clients' chrome. */
  private syncRecord(): void {
    const { title, url } = this.activeTab
    const patch: { title?: string; fields?: { url: string } } = {}
    if (title && title !== this.record.title) patch.title = title
    if (url !== this.record.fields.url) patch.fields = { url }
    if (!patch.title && !patch.fields) return
    try {
      this.kit.document.apply({ kind: 'updatePanel', id: this.panelId, patch })
    } catch (err) {
      this.kit.log.warn('browser %s: record update failed: %O', this.panelId, err)
    }
  }

  /** `source`: the client whose selection this is (null: a caller's, which
   *  every client shows). */
  private setTabs(tabs: BrowserTab[], activeTabId = this.state.activeTabId, source: string | null = null): void {
    const previous = this.state.activeTabId
    const next = tabs.some((tab) => tab.id === activeTabId) ? activeTabId : tabs[0].id
    this.publish({ tabs, activeTabId: next, ...(next !== previous ? { activeSource: source } : {}) })
    // A newly shown tab's navigation state comes from the next client report.
    if (next !== previous) this.publish({ canGoBack: false, canGoForward: false, isLoading: false, loadError: null, crashed: false })
    this.save()
    this.syncRecord()
  }

  private patchTab(tabId: string, patch: Partial<BrowserTab>): BrowserTab {
    const tab = this.tab(tabId)
    const next = { ...tab, ...patch }
    this.setTabs(this.state.tabs.map((candidate) => (candidate.id === tabId ? next : candidate)))
    return next
  }

  private publishDownloads(entries: BrowserDownloadEntry[]): void {
    const downloads: BrowserDownload[] = [...entries]
      .sort((a, b) => b.at - a.at)
      .map(({ id, url, filename, filePath, state, receivedBytes, totalBytes, at }) => ({ id, url, filename, filePath, state, receivedBytes, totalBytes, at }))
    this.publish({ downloads })
  }

  private showAgentCursor(event: AgentCursorEvent): void {
    const previous = this.state.agentCursor
    const keep = event.kind !== 'done'
    this.publish({
      agentCursor: {
        event: {
          kind: event.kind,
          label: event.label,
          x: event.x ?? (keep ? previous?.event.x ?? null : null),
          y: event.y ?? (keep ? previous?.event.y ?? null : null),
          toX: event.toX ?? null,
          toY: event.toY ?? null,
        },
        serial: (previous?.serial ?? 0) + 1,
      },
    })
  }

  // ---- Tabs and navigation (the same for views and the cate API) ----------

  /** Sets a tab's URL for every client to load. Returns the tab's new `nav`. */
  async navigateTab(tabId: string, input: string): Promise<number> {
    const engine = (this.deps.settings.get('browserSearchEngine') as BrowserSearchEngine | undefined) ?? 'google'
    const trimmed = input.trim()
    if (!trimmed) throw new RpcError('rejected', 'url-required')
    const address = isStartPage(trimmed) ? trimmed : resolveAddress(trimmed, engine, isBrowserInternalPage)
    const file = filePathOfUrl(address)
    const url = file ? await this.deps.files.serveUrl(file) : address
    const tab = this.tab(tabId)
    const next = this.patchTab(tabId, {
      url,
      title: isBrowserInternalPage(url) ? browserInternalPageTitle(url) : tab.title,
      nav: tab.nav + 1,
      navSource: null,
    })
    if (tabId === this.state.activeTabId) this.publish({ isLoading: hasPage(url), loadError: null, crashed: false })
    return next.nav
  }

  /** Opens a tab on `url` (a `file://` URL through the workspace's file
   *  server, like `navigate`). Returns the new tab's id. */
  async newTab(url?: string, source: string | null = null): Promise<string> {
    const homepage = this.deps.settings.get('browserHomepage')
    const behavior = this.deps.settings.get('browserNewTabBehavior') as BrowserNewTabBehavior | undefined
    const file = url ? filePathOfUrl(url) : null
    const page = file ? await this.deps.files.serveUrl(file) : url
    const target = page || (behavior === 'homepage' && typeof homepage === 'string' && homepage) || BROWSER_NEW_TAB_URL
    const tab: BrowserTab = {
      id: `tab-${this.newId()}`,
      url: target,
      title: browserInternalPageTitle(target),
      favicon: null,
      pinned: false,
      nav: 1,
      navSource: null,
    }
    this.setTabs([...this.state.tabs, tab], tab.id, source)
    this.publish({ isLoading: hasPage(target) })
    return tab.id
  }

  closeTab(tabId: string, source: string | null = null): void {
    const index = this.state.tabs.findIndex((tab) => tab.id === tabId)
    if (index < 0) throw new RpcError('gone', 'no-such-tab')
    const tabs = this.state.tabs.filter((tab) => tab.id !== tabId)
    if (tabs.length === 0) {
      tabs.push({ id: `tab-${this.newId()}`, url: BROWSER_NEW_TAB_URL, title: '', favicon: null, pinned: false, nav: 0, navSource: null })
    }
    const activeTabId = tabId === this.state.activeTabId ? tabs[Math.min(index, tabs.length - 1)].id : this.state.activeTabId
    this.setTabs(tabs, activeTabId, source)
  }

  selectTab(tabId: string, source: string | null = null): void {
    this.tab(tabId)
    if (tabId !== this.state.activeTabId) this.setTabs(this.state.tabs, tabId, source)
  }

  private setViewport(viewport: BrowserViewport): void {
    if (!validViewport(viewport)) throw new RpcError('rejected', 'invalid-browser-viewport')
    this.publish({ viewport: viewport.preset === 'compact' ? COMPACT_VIEWPORT : { ...viewport } })
    this.save()
  }

  // ---- Ops ----------------------------------------------------------------

  protected override readonly ops: OpHandlers<BrowserOp> = {
    navigate: async ({ input, tabId }) => { await this.navigateTab(tabId ?? this.state.activeTabId, input) },
    newTab: ({ url }, ctx) => this.newTab(url, ctx.clientId),
    closeTab: ({ tabId }, ctx) => { this.closeTab(tabId, ctx.clientId) },
    selectTab: ({ tabId }, ctx) => { this.selectTab(tabId, ctx.clientId) },
    pin: ({ tabId, pinned }) => { this.patchTab(tabId, { pinned: pinned ?? !this.tab(tabId).pinned }) },
    reportNavigation: (op, ctx) => this.reportNavigation(op, ctx),
    reportTitle: ({ tabId, title }) => {
      const tab = this.tab(tabId)
      if (!title || title === tab.title) return
      this.patchTab(tabId, { title })
      if (isRecordableBrowserUrl(tab.url) && hasPage(tab.url)) this.deps.browserData.history.recordVisit(tab.url, title)
    },
    reportFavicon: ({ tabId, favicon }) => {
      if (typeof favicon === 'string' && favicon !== this.tab(tabId).favicon) this.patchTab(tabId, { favicon })
    },
    reportLoad: ({ tabId, loading, loadError, crashed, canGoBack, canGoForward }) => {
      this.tab(tabId)
      if (tabId !== this.state.activeTabId) return
      const patch: Partial<BrowserSnapshot> = {}
      if (canGoBack !== undefined) patch.canGoBack = canGoBack
      if (canGoForward !== undefined) patch.canGoForward = canGoForward
      if (loading !== undefined) patch.isLoading = loading
      if (loadError !== undefined) patch.loadError = loadError
      if (crashed !== undefined) patch.crashed = crashed
      if (loading) Object.assign(patch, { loadError: null, crashed: false })
      if (loadError || crashed) patch.isLoading = false
      this.publish(patch)
    },
    history: async ({ action, tabId }) => {
      const target = tabId ?? this.state.activeTabId
      const { ok } = await this.page('page.history', { tabId: target, action })
      return ok
    },
    setViewport: ({ viewport }) => { this.setViewport(viewport) },
    releaseAgentCursor: () => {
      if (this.state.agentCursor && this.state.agentCursor.event.kind !== 'done') this.showAgentCursor({ kind: 'done', label: '' })
    },
  }

  private reportNavigation(op: Extract<BrowserOp, { kind: 'reportNavigation' }>, ctx: OpContext): void {
    const { tabId, url, inPage, canGoBack, canGoForward } = op
    // about:blank fires while a guest spins up or tears down.
    if (!url || url === 'about:blank') return
    const tab = this.tab(tabId)
    const patch: Partial<BrowserTab> = {}
    if (url !== tab.url) Object.assign(patch, { url, nav: tab.nav + 1, navSource: ctx.clientId })
    if (!inPage && typeof op.title === 'string' && op.title) patch.title = op.title
    if (Object.keys(patch).length) this.patchTab(tabId, patch)
    if (!inPage && isRecordableBrowserUrl(url)) this.deps.browserData.history.recordVisit(url, op.title ?? tab.title)
    if (tabId === this.state.activeTabId) {
      this.publish({ canGoBack: !!canGoBack, canGoForward: !!canGoForward, ...(inPage ? {} : { isLoading: false, loadError: null }) })
    }
  }

  // ---- Page operations on the driving client --------------------------------

  private page<Op extends BrowserSurfaceOp>(op: Op, args: BrowserSurfaceArgs<Op>): Promise<BrowserSurfaceResult<Op>> {
    return this.withSurface<BrowserSurfaceResult<Op>>(op, args)
  }

  /** The active tab `tabId`, with a web page. A user's tab switch cancels
   *  work bound to the tab it left. */
  private boundTab(tabId: unknown): BrowserTab {
    if (typeof tabId !== 'string') throw new RpcError('rejected', 'tabId-required')
    if (tabId !== this.state.activeTabId) throw changed('browser-tab-changed')
    const tab = this.activeTab
    if (!hasPage(tab.url) && !isStartPage(tab.url)) throw new RpcError('rejected', 'The active tab has no web page')
    return tab
  }

  private still(tabId: string): void {
    if (this.isDisposed) throw new RpcError('gone', `panel ${this.panelId} is gone`)
    if (this.state.activeTabId !== tabId) throw changed('browser-tab-changed')
  }

  private async execute(tabId: string, method: string, args: Record<string, unknown>, settle = false): Promise<unknown> {
    const response: BrowserDriverResult = await this.page('page.execute', { tabId, method, args, ...(settle ? { settle } : {}) })
    if (response.cursor) this.showAgentCursor(response.cursor)
    if (response.error) throw new RpcError('rejected', response.recovery ? `${response.error}: ${response.recovery}` : response.error)
    return response.result
  }

  private async pageInfo(tabId: string): Promise<{ panelId: string; tabId: string; url: string; title: string }> {
    const tab = this.tab(tabId)
    if (isBrowserInternalPage(tab.url)) throw new RpcError('rejected', 'The active tab has no web page')
    const page = await this.page('page.ready', { tabId, nav: tab.nav })
    this.still(tabId)
    return { panelId: this.panelId, tabId, ...page }
  }

  /** Reruns an observation to fail fast when the user took over since `args` was observed. */
  private async checkUserInput(tabId: string, args: Record<string, unknown>): Promise<void> {
    if (args._userInputEpoch !== undefined) await this.execute(tabId, 'getAXState', args)
  }

  private async observeAfterNavigation(tabId: string, args: Record<string, unknown>): Promise<unknown> {
    await this.page('page.ready', { tabId, nav: this.tab(tabId).nav })
    this.still(tabId)
    return this.execute(tabId, 'getAXState', { ...args, disableDiffing: true })
  }

  private async pageMethod(method: string, args: Record<string, unknown>): Promise<unknown> {
    const tab = this.boundTab(args.tabId)
    const tabId = tab.id
    if (BROWSER_ACTION_METHODS.has(method)) this.showAgentCursor({ kind: cursorKind(method), label: method })
    return this.execute(tabId, method, args)
  }

  override handleApi = sessionApi(browserApi, {
    getTab: async ({ tabId }) => {
      if (tabId && tabId !== this.state.activeTabId) this.selectTab(tabId)
      return this.pageInfo(tabId ?? this.state.activeTabId)
    },
    createTab: async ({ url }) => this.pageInfo(await this.newTab(url)),

    getAXState: (args) => this.pageMethod('getAXState', args),
    getScreenshot: (args) => this.pageMethod('getScreenshot', args),
    getAXStateAndScreenshot: (args) => this.pageMethod('getAXStateAndScreenshot', args),
    getAttribute: (args) => this.pageMethod('getAttribute', args),
    waitFor: (args) => this.pageMethod('waitFor', args),
    click: (args) => this.pageMethod('click', args),
    setValue: (args) => this.pageMethod('setValue', args),
    typeText: (args) => this.pageMethod('typeText', args),
    pressKey: (args) => this.pageMethod('pressKey', args),
    scroll: (args) => this.pageMethod('scroll', args),
    drag: (args) => this.pageMethod('drag', args),
    selectText: (args) => this.pageMethod('selectText', args),
    setChecked: (args) => this.pageMethod('setChecked', args),
    selectOption: (args) => this.pageMethod('selectOption', args),
    upload: (args) => this.pageMethod('upload', args),

    downloads: (args) => {
      this.boundTab(args.tabId)
      return { downloads: this.state.downloads }
    },
    close: (args) => {
      this.closeTab(this.boundTab(args.tabId).id)
      return { closed: true }
    },
    goto: async (args) => {
      const tabId = this.boundTab(args.tabId).id
      await this.checkUserInput(tabId, args)
      this.still(tabId)
      await this.navigateTab(tabId, args.url)
      return this.observeAfterNavigation(tabId, args)
    },
    back: (args) => this.historyMethod('back', args),
    forward: (args) => this.historyMethod('forward', args),
    reload: (args) => this.historyMethod('reload', args),
    setViewport: async (args) => {
      const tabId = this.boundTab(args.tabId).id
      const { preset } = args
      const width = preset === 'compact' ? 640 : args.width
      const height = preset === 'compact' ? 480 : args.height
      if (!width || !height) throw new RpcError('rejected', 'invalid-browser-viewport')
      this.setViewport(preset === 'compact'
        ? COMPACT_VIEWPORT
        : { preset: preset === 'mobile' || preset === 'desktop' ? preset : 'custom', width, height })
      const observation = await this.execute(tabId, 'getAXState', args, true)
      return { preset, width, height, observation }
    },
    resize: (args, ctx) => this.resize(args, ctx),
    download: async (args) => {
      const tab = this.boundTab(args.tabId)
      await this.checkUserInput(tab.id, args)
      const current = hasPage(tab.url) ? tab.url : ''
      if (!args.url && !current) throw new RpcError('rejected', 'url-required')
      let url: string
      try {
        url = args.url === undefined ? current : new URL(args.url, current || undefined).href
      } catch {
        throw new RpcError('rejected', 'invalid-browser-url')
      }
      return this.page('page.download', { tabId: tab.id, url })
    },
  })

  private async historyMethod(action: 'back' | 'forward' | 'reload', args: Record<string, unknown>): Promise<unknown> {
    const tabId = this.boundTab(args.tabId).id
    await this.checkUserInput(tabId, args)
    this.still(tabId)
    const { ok } = await this.page('page.history', { tabId, action })
    if (!ok) throw new RpcError('rejected', 'no-history')
    this.still(tabId)
    return this.observeAfterNavigation(tabId, args)
  }

  private resize(args: { tabId: string; width: number; height: number }, _ctx: ApiSessionContext): unknown {
    this.boundTab(args.tabId)
    const { width, height } = args
    const minimum = definition.minimumSize
    if (width < minimum.width || height < minimum.height) {
      throw new RpcError('rejected', `minimum-browser-panel-size-${minimum.width}x${minimum.height}`)
    }
    const doc = this.kit.document.get()
    const placement = placementOf(doc, this.panelId)
    if (!placement) throw new RpcError('gone', 'panel-not-placed')
    if (!isCanvasDock(placement.dock)) throw new RpcError('rejected', 'browser-panel-is-docked')
    const { canvasId, nodeId } = placement.dock
    const node = doc.canvases[canvasId]?.nodes[nodeId]
    if (!node) throw new RpcError('gone', 'panel-not-placed')
    this.kit.document.apply({ kind: 'setNodeRects', canvasId, rects: [{ nodeId, rect: { origin: node.rect.origin, size: { width, height } } }] })
    return { panelId: this.panelId, width, height }
  }
}

/** The session class the panel registry holds, with its deps bound. */
export function createBrowserSessionClass(deps: BrowserSessionDeps): PanelSessionClass {
  return class extends BrowserSession {
    constructor(kit: SessionKit, record: PanelRecord) {
      super(kit, record, deps)
    }
  } as unknown as PanelSessionClass
}
