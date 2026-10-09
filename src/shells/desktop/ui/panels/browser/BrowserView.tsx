// The browser panel view: chrome around one <webview> per tab. It renders the
// session snapshot, sends ops, loads pages itself (every client follows the
// session URL, see `pageHost.ts`), and when this client drives the panel,
// answers the runtime's page operations through its `BrowserPageHost`.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Camera,
  Download as DownloadSimple,
  EllipsisVertical as DotsThreeVertical,
  Globe,
  Key,
  RotateCw as ArrowClockwise,
  Star,
} from 'lucide-react'
import { Button, PanelCenteredState, POPOVER_SURFACE, Spinner, Tooltip } from '../../kernel/interaction'
import { clientUi } from '@kernel/interaction'
import { useRuntime } from '../../kernel/rpc'
import { clientIdentity } from '@client/connections'
import { usePanelView } from '../../client/document'
import type { PanelViewProps } from '../../client/host/views'
import { BROWSER_NEW_TAB_URL, queryBrowserHistoryEntries, type BrowserShortcutAction } from '@services/browser/contract'
import { browserPageBridge, browserPartition, subscribeBrowserPartitions } from '@services/browser/client'
import { fsClient } from '@workspace/files/client'
import { base64ToBytes, writeFileRefDrag, type FileRef } from '@workspace/files/contract'
import { BrowserPasswordManagerPage, useBrowserData } from '../../services/browser'
import type { BrowserOp, BrowserSnapshot, BrowserViewport } from '@panels/browser/contract'
import { BROWSER_HISTORY_URL, BROWSER_PASSWORD_MANAGER_URL, isBrowserInternalPage, stepBrowserZoom } from '@panels/browser/contract'
import { BrowserPageHost, type BrowserGuest } from './pageHost'
import { registerSurface } from '@client/host'
import { runPageOp } from './surfaces'
import { actOnLocalDownload, isLocalDownload, localDownloadsVersion, ownGuest, relayDownloads, subscribeLocalDownloads } from './localDownloads'
import { AgentCursorOverlay } from './parts/AgentCursorOverlay'
import { BrowserDownloadsPopover, type BrowserPanelDownload } from './parts/BrowserDownloadsPopover'
import { BrowserHistoryPage } from './parts/BrowserHistoryPage'
import { BrowserMenu } from './parts/BrowserMenu'
import { BrowserTabStrip } from './parts/BrowserTabStrip'
import { StartPage } from './parts/StartPage'
import { UrlSuggestions } from './parts/UrlSuggestions'

const COMPACT_BROWSER_SCALE = 0.75
const isStartPage = (url: string) => url === BROWSER_NEW_TAB_URL

function browserViewportScale(viewport: BrowserViewport, container: { width: number; height: number }): number {
  if (viewport.preset === 'compact') return COMPACT_BROWSER_SCALE
  if (container.width <= 0 || container.height <= 0) return 0.5
  return Math.min(1, container.width / viewport.width, container.height / viewport.height)
}

// Guests are isolated documents: the view's scrollbar styles do not reach them.
function guestScrollbarCss(): string {
  const vars = getComputedStyle(document.documentElement)
  const thumb = vars.getPropertyValue('--scrollbar-thumb').trim() || 'rgba(255,255,255,0.15)'
  const hover = vars.getPropertyValue('--scrollbar-thumb-hover').trim() || 'rgba(255,255,255,0.25)'
  return '::-webkit-scrollbar{width:13.52px;height:13.52px}::-webkit-scrollbar-track{background:transparent}'
    + `::-webkit-scrollbar-thumb{background:${thumb};border-radius:9999px}::-webkit-scrollbar-thumb:hover{background:${hover}}`
    + '::-webkit-scrollbar-corner{background:transparent}'
}

function shortcutFor(event: React.KeyboardEvent): BrowserShortcutAction | null {
  if (!(event.metaKey || event.ctrlKey)) return null
  switch (event.code) {
    case 'KeyR': return event.shiftKey ? 'reloadHard' : 'reload'
    case 'KeyL': return event.shiftKey ? null : 'focusUrl'
    case 'BracketLeft': return event.shiftKey ? null : 'back'
    case 'BracketRight': return event.shiftKey ? null : 'forward'
    default: return null
  }
}

function WebviewSlot({ tabId, src, partition, active, hidden, viewport, displayScale, onElement }: {
  tabId: string
  src: string
  partition: string
  active: boolean
  hidden: boolean
  viewport: BrowserViewport
  displayScale: number
  onElement(tabId: string, element: BrowserGuest | null): void
}) {
  const attach = useCallback((element: BrowserGuest | null) => onElement(tabId, element), [onElement, tabId])
  const fixed = viewport.preset !== 'compact'
  const frameStyle = fixed
    ? { width: viewport.width * displayScale, height: viewport.height * displayScale }
    : { width: '100%', height: '100%' }
  const webviewStyle = fixed
    ? { width: viewport.width, height: viewport.height }
    : { width: `${100 / displayScale}%`, height: `${100 / displayScale}%` }
  return (
    <div
      data-browser-webview-slot
      data-browser-src={src}
      data-browser-partition={partition}
      className={`${active ? 'relative' : 'absolute inset-0 invisible pointer-events-none'} overflow-hidden bg-surface-0`}
      style={frameStyle}
    >
      <webview
        ref={attach as never}
        src={src}
        className={hidden ? 'invisible' : ''}
        style={{
          ...webviewStyle,
          // Transparent pages need a browser canvas, not Cate's themed surface.
          backgroundColor: '#fff',
          transform: `scale(${displayScale})`,
          transformOrigin: 'top left',
        }}
        partition={partition}
        {...({ allowpopups: 'true', webpreferences: 'backgroundThrottling=no' } as object)}
      />
    </div>
  )
}

function ErrorOverlay({ title, description, buttonLabel, onRetry }: { title: string; description: string; buttonLabel: string; onRetry: () => void }) {
  return (
    <PanelCenteredState
      className="absolute inset-0 z-10"
      icon={<Globe size={32} />}
      title={title}
      description={description}
      actions={<Button size="sm" onClick={onRetry}>{buttonLabel}</Button>}
    />
  )
}

export default function BrowserView({ workspaceId, panelId, snapshot, send, visible, focused }: PanelViewProps<BrowserSnapshot, BrowserOp>) {
  const partition = useSyncExternalStore(subscribeBrowserPartitions, () => browserPartition(workspaceId))
  if (!snapshot || !partition) return <PanelCenteredState icon={<Spinner size={18} />} title="Loading" />
  return <BrowserContent workspaceId={workspaceId} panelId={panelId} partition={partition} snapshot={snapshot} send={send} visible={visible} focused={focused} />
}

function BrowserContent({ workspaceId, panelId, partition, snapshot, send, visible, focused }: {
  workspaceId: string
  panelId: string
  partition: string
  snapshot: BrowserSnapshot
  send: (op: BrowserOp) => Promise<unknown>
  visible: boolean
  focused: boolean
}) {
  const runtime = useRuntime(workspaceId)
  const bridge = browserPageBridge()
  const { store: browserData, state: { bookmarks, history } } = useBrowserData(workspaceId)
  const quietly = useCallback((op: BrowserOp) => { void send(op).catch(() => { /* shown by the next snapshot */ }) }, [send])

  // Page zoom is client state: each client zooms the pages it shows.
  const [zoom, setZoom] = usePanelView<number>(workspaceId, panelId, 'zoom', 1)

  // Which tab this client shows is client state. It follows this client's own
  // selections and callers' (`activeSource` null), never another client's.
  const [storedTab, setShown] = usePanelView<string | null>(workspaceId, panelId, 'tab', null)
  const shownTabId = storedTab && snapshot.tabs.some((tab) => tab.id === storedTab) ? storedTab : snapshot.activeTabId
  // Keep the tab shown so far (the session's until this client picks one).
  useEffect(() => { if (storedTab !== shownTabId) setShown(shownTabId) }, [storedTab, shownTabId, setShown])
  const followed = useRef({ tabId: snapshot.activeTabId, source: snapshot.activeSource })
  useEffect(() => {
    const { activeTabId: tabId, activeSource: source } = snapshot
    if (followed.current.tabId === tabId && followed.current.source === source) return
    followed.current = { tabId, source }
    if (source === null || source === clientIdentity().clientId) setShown(tabId)
  }, [snapshot, setShown])

  // The host outlives re-renders: it owns the mounted pages. Changing inputs
  // are read through refs.
  const live = useRef({ send, runtime, setShown })
  live.current = { send, runtime, setShown }
  const host = useMemo(() => new BrowserPageHost({
    panelId,
    clientId: clientIdentity().clientId,
    send: (op) => live.current.send(op),
    reveal: (tabId) => live.current.setShown(tabId),
    bridge,
    guestCss: guestScrollbarCss,
    confirmSave: (message) => clientUi().confirm(message),
    passwords: {
      suggestions: async (url) => (await live.current.runtime?.browserData.passwordSuggestions({ url })) ?? [],
      forFill: async (id, url) => (await live.current.runtime?.browserData.passwordForFill({ id, url })) ?? null,
      saveDisposition: async (input) => (await live.current.runtime?.browserData.passwordSaveDisposition({ input })) ?? 'unchanged',
      save: async (input) => live.current.runtime?.browserData.savePassword({ input }),
    },
    fetchUpload: async (path) => {
      const current = live.current.runtime
      if (!current) throw new Error('The workspace is not connected')
      const upload = current.browserData.upload({ path })
      let name = 'upload'
      const chunks: Uint8Array[] = []
      upload.onEvent((header) => { name = header.name })
      upload.onBytes((chunk) => { chunks.push(chunk) })
      await upload.done
      const bytes = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.byteLength, 0))
      let offset = 0
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
      return { name, bytes }
    },
  }), [panelId, bridge])
  useEffect(() => () => host.dispose(), [host])
  useEffect(() => {
    if (!bridge) return
    return registerSurface(workspaceId, panelId, (request) => runPageOp(host, request))
  }, [workspaceId, panelId, host, bridge])
  useSyncExternalStore(host.subscribe, host.getVersion)

  useLayoutEffect(() => { host.update(snapshot) }, [host, snapshot])
  useLayoutEffect(() => { host.show(shownTabId) }, [host, shownTabId])
  useEffect(() => { host.visible = visible }, [host, visible])
  useEffect(() => { host.applyZoom(zoom) }, [host, zoom])

  const { tabs, viewport } = snapshot
  const activeTab = tabs.find((tab) => tab.id === shownTabId) ?? tabs[0]
  // The agent acts on the session's active tab; its cursor shows only there.
  const agentCursor = shownTabId === snapshot.activeTabId ? snapshot.agentCursor : null
  const currentUrl = host.displayUrl()
  const { canGoBack, canGoForward, isLoading, loadError, crashed } = host.local
  const autofill = host.autofill

  // A tab's page mounts the first time this client shows it, then stays
  // mounted (hidden by its slot) so switching back keeps its state. A guest
  // attached while hidden can stay blank, and other clients' tabs need no page.
  const shownTabs = useRef(new Set<string>())
  shownTabs.current.add(shownTabId)
  // Seeds stay fixed per mounted webview, so a re-render never reloads a page.
  const seeds = useRef(new Map<string, string>())
  const srcFor = (tabId: string): string => {
    const tab = tabs.find((candidate) => candidate.id === tabId)!
    if (!seeds.current.has(tabId)) seeds.current.set(tabId, host.seedFor(tab))
    return seeds.current.get(tabId)!
  }
  // Stable, so React never detaches a live guest on re-render.
  const onElement = useCallback((tabId: string, element: BrowserGuest | null) => {
    if (!element) seeds.current.delete(tabId)
    host.attachGuest(tabId, element)
    if (element && bridge) {
      element.addEventListener('dom-ready', () => {
        const current = live.current.runtime
        if (!current) return
        const storeDownload = (filename: string, bytes: Uint8Array) => fsClient(workspaceId).storeDownload(filename, bytes)
        try { ownGuest(element.getWebContentsId(), { panelId, browserData: current.browserData, storeDownload }) } catch { /* not attached yet */ }
      })
    }
    host.refreshLocal()
  }, [host, bridge, panelId, workspaceId])

  useEffect(() => { if (bridge) relayDownloads(bridge) }, [bridge])
  useSyncExternalStore(subscribeLocalDownloads, localDownloadsVersion)

  // New windows a page opens become tabs of its panel.
  useEffect(() => bridge?.onOpenTab(({ openerWebContentsId, url }) => {
    if (host.tabForGuest(openerWebContentsId)) quietly({ kind: 'newTab', url })
  }), [bridge, host, quietly])

  // ---- Address bar ------------------------------------------------------------

  const urlInputRef = useRef<HTMLInputElement | null>(null)
  const [inputUrl, setInputUrl] = useState(isStartPage(currentUrl) ? '' : currentUrl)
  useEffect(() => { setInputUrl(isStartPage(currentUrl) ? '' : currentUrl) }, [currentUrl, shownTabId])
  const [showSuggestions, setShowSuggestions] = useState(false)
  const [activeSuggestion, setActiveSuggestion] = useState(-1)
  const suggestions = useMemo(
    () => (showSuggestions ? queryBrowserHistoryEntries(history, inputUrl, 8) : []),
    [showSuggestions, inputUrl, history],
  )
  const navigate = useCallback((input: string) => {
    if (input.trim()) quietly({ kind: 'navigate', input, tabId: shownTabId })
  }, [quietly, shownTabId])

  const onUrlKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveSuggestion((index) => Math.min(index + 1, suggestions.length - 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveSuggestion((index) => Math.max(index - 1, -1))
    } else if (event.key === 'Escape') {
      setShowSuggestions(false)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const pick = activeSuggestion >= 0 ? suggestions[activeSuggestion]?.url : undefined
      setShowSuggestions(false)
      navigate(pick ?? inputUrl)
    }
  }

  const focusUrl = useCallback(() => {
    urlInputRef.current?.focus()
    urlInputRef.current?.select()
  }, [])

  // ---- Shortcuts --------------------------------------------------------------

  const shortcut = useCallback((action: BrowserShortcutAction) => {
    if (action === 'focusUrl') focusUrl()
    else host.historyAction(action)
  }, [host, focusUrl])
  // Keys pressed inside a guest, or the Browser menu, go to the focused browser.
  useEffect(() => bridge?.onShortcut((action) => { if (focused) shortcut(action) }), [bridge, focused, shortcut])

  useEffect(() => {
    if (!focused || !isStartPage(currentUrl)) return
    const frame = requestAnimationFrame(() => {
      if (!document.body.classList.contains('canvas-dragging')) urlInputRef.current?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [currentUrl, focused])

  useEffect(() => {
    if (!focused) return
    const webview = host.webview()
    if (!webview) return
    const frame = requestAnimationFrame(() => {
      // Start pages keep an invisible guest for automation; user focus belongs to the address bar.
      if (isStartPage(activeTab.url)) return
      // Focusing a webview blurs the host window and cancels a pending canvas drag.
      if (document.body.classList.contains('canvas-dragging')) return
      webview.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [focused, host, shownTabId, activeTab.url])

  // ---- Menus, downloads, screenshot ---------------------------------------------

  const [menuOpen, setMenuOpen] = useState(false)
  const [downloadsOpen, setDownloadsOpen] = useState(false)
  const menuButtonRef = useRef<HTMLButtonElement>(null)
  const downloadButtonRef = useRef<HTMLButtonElement>(null)
  const downloads: BrowserPanelDownload[] = snapshot.downloads.map((download) => ({ ...download, local: isLocalDownload(download.id) }))
  // A new download opens the popover once; remounting does not reopen it.
  const seenDownloads = useRef(new Set(snapshot.downloads.map((download) => download.id)))
  useEffect(() => {
    const fresh = snapshot.downloads.some((download) => !seenDownloads.current.has(download.id) && isLocalDownload(download.id))
    for (const download of snapshot.downloads) seenDownloads.current.add(download.id)
    if (!fresh) return
    setMenuOpen(false)
    setDownloadsOpen(true)
  }, [snapshot.downloads])

  // The capture is stored in the workspace data (`file.storeScreenshot`) as
  // soon as it is taken, so its drag carries a FileRef any panel can use.
  const [screenshot, setScreenshot] = useState<{ dataUrl: string; ref: FileRef | null } | null>(null)
  const screenshotTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (screenshotTimer.current) clearTimeout(screenshotTimer.current) }, [])
  const takeScreenshot = async () => {
    const webview = host.webview()
    if (!webview || !bridge) return
    let result: { dataUrl: string } | null = null
    try { result = await bridge.screenshot(webview.getWebContentsId()) } catch { return }
    if (!result) return
    const { dataUrl } = result
    const name = `browser-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.png`
    const ref = await fsClient(workspaceId).storeScreenshot(name, base64ToBytes(dataUrl.slice(dataUrl.indexOf(',') + 1)))
      .then(({ path }): FileRef => ({ workspaceId, path }), () => null)
    if (screenshotTimer.current) clearTimeout(screenshotTimer.current)
    setScreenshot({ dataUrl, ref })
    screenshotTimer.current = setTimeout(() => { setScreenshot(null); screenshotTimer.current = null }, 5000)
  }

  const isBookmarked = bookmarks.some((bookmark) => bookmark.url === currentUrl)
  const canBookmark = !isStartPage(currentUrl) && !isBrowserInternalPage(currentUrl) && !currentUrl.startsWith('about:')

  // ---- Layout -------------------------------------------------------------------

  const containerRef = useRef<HTMLDivElement | null>(null)
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 })
  const displayScale = browserViewportScale(viewport, containerSize)
  useEffect(() => {
    const element = containerRef.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const update = () => setContainerSize({ width: element.clientWidth, height: element.clientHeight })
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const autofillRef = useRef<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    const popup = autofillRef.current
    const container = containerRef.current
    if (!autofill || !popup || !container) return
    // Page zoom and the viewport's display scale only: the canvas transform
    // already applies to both the popup and the page.
    const scale = zoom * displayScale
    const fieldBottom = autofill.rect.bottom * scale
    const fieldTop = (autofill.rect.bottom - autofill.rect.height) * scale
    const left = Math.max(0, Math.min(autofill.rect.left * scale, container.clientWidth - popup.offsetWidth))
    const below = fieldBottom + 6
    const top = below + popup.offsetHeight <= container.clientHeight ? below : Math.max(0, fieldTop - popup.offsetHeight - 6)
    popup.style.left = `${left}px`
    popup.style.top = `${top}px`
  }, [autofill, zoom, displayScale, containerSize])

  const releaseAgent = () => {
    if (agentCursor && agentCursor.event.kind !== 'done') quietly({ kind: 'releaseAgentCursor' })
  }
  const reload = () => { host.historyAction('reload') }
  const iconButton = 'w-7 h-7 flex items-center justify-center rounded-[10px] hover:bg-hover disabled:opacity-30 disabled:hover:bg-transparent text-secondary hover:text-primary transition-colors'

  return (
    <div
      className="flex w-full h-full relative"
      onKeyDown={(event) => {
        releaseAgent()
        const action = shortcutFor(event)
        if (!action) return
        event.preventDefault()
        shortcut(action)
      }}
      onPointerDownCapture={releaseAgent}
    >
      <div className="flex flex-col flex-1 min-w-0 h-full">
        <BrowserTabStrip
          tabs={tabs}
          activeTabId={shownTabId}
          onSelect={(tabId) => {
            setShown(tabId)
            quietly({ kind: 'selectTab', tabId })
          }}
          onClose={(tabId) => {
            const index = tabs.findIndex((tab) => tab.id === tabId)
            const rest = tabs.filter((tab) => tab.id !== tabId)
            if (tabId === shownTabId && rest.length) setShown(rest[Math.min(index, rest.length - 1)].id)
            quietly({ kind: 'closeTab', tabId })
          }}
          onNewTab={() => quietly({ kind: 'newTab' })}
          onTogglePin={(tabId) => quietly({ kind: 'pin', tabId })}
        />

        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-subtle bg-surface-1 px-2" data-browser-toolbar>
          <div className="flex shrink-0 items-center gap-1">
            <Tooltip label="Back (⌘[)">
              <button onClick={() => host.historyAction('back')} disabled={!canGoBack} className={iconButton} aria-label="Back">
                <ArrowLeft size={14} />
              </button>
            </Tooltip>
            <Tooltip label="Forward (⌘])">
              <button onClick={() => host.historyAction('forward')} disabled={!canGoForward} className={iconButton} aria-label="Forward">
                <ArrowRight size={14} />
              </button>
            </Tooltip>
            <Tooltip label="Reload (⌘R)">
              <button onClick={reload} disabled={isStartPage(currentUrl)} className={iconButton} aria-label="Reload">
                {isLoading ? <Spinner size={14} /> : <ArrowClockwise size={14} />}
              </button>
            </Tooltip>
          </div>

          <div className="flex-1 relative">
            <div
              data-input-frame
              className={`flex h-7 items-center gap-2 rounded-[10px] border px-3 transition-colors ${
                isStartPage(currentUrl)
                  ? 'border-strong bg-surface-1 focus-within:border-strong'
                  : 'border-transparent bg-transparent hover:bg-surface-2 focus-within:border-strong focus-within:bg-surface-1'
              }`}
            >
              <input
                ref={urlInputRef}
                type="text"
                value={inputUrl}
                onChange={(event) => { setInputUrl(event.target.value); setShowSuggestions(true); setActiveSuggestion(-1) }}
                onFocus={() => setShowSuggestions(true)}
                onBlur={() => setTimeout(() => setShowSuggestions(false), 120)}
                onKeyDown={onUrlKeyDown}
                className={`h-full min-w-0 flex-1 bg-transparent text-sm text-primary outline-none placeholder:text-muted ${
                  isStartPage(currentUrl) ? 'text-left' : 'text-center'
                }`}
                placeholder="Enter a URL"
                title="Address bar (⌘L)"
              />
              {isStartPage(currentUrl) && (
                <button
                  type="button"
                  onClick={() => navigate(inputUrl)}
                  disabled={!inputUrl.trim()}
                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-secondary transition-colors hover:text-primary disabled:opacity-50"
                  aria-label="Open address"
                >
                  <ArrowUpRight size={15} />
                </button>
              )}
            </div>
            <UrlSuggestions
              items={suggestions}
              activeIndex={activeSuggestion}
              onPick={(url) => { setShowSuggestions(false); navigate(url) }}
              onHover={setActiveSuggestion}
            />
          </div>

          {downloads.length > 0 && (
            <Tooltip label="Downloads">
              <button
                ref={downloadButtonRef}
                type="button"
                onClick={() => { setMenuOpen(false); setDownloadsOpen((open) => !open) }}
                className={`relative flex h-7 w-7 items-center justify-center rounded-[10px] transition-colors hover:bg-hover hover:text-primary ${
                  downloadsOpen ? 'bg-hover text-primary' : 'text-secondary'
                }`}
                aria-label="Downloads"
                aria-expanded={downloadsOpen}
              >
                <DownloadSimple size={14} />
                {downloads.some((download) => download.state === 'progressing') && (
                  <span className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-agent" />
                )}
              </button>
            </Tooltip>
          )}

          {!isStartPage(currentUrl) && (
            <>
              <Tooltip label={isBookmarked ? 'Remove bookmark' : 'Bookmark this page'}>
                <button
                  onClick={() => { if (canBookmark) void browserData?.toggleBookmark(currentUrl, activeTab.title || currentUrl) }}
                  disabled={!canBookmark}
                  className={`w-7 h-7 flex items-center justify-center rounded-[10px] transition-colors disabled:opacity-30 ${
                    isBookmarked ? 'text-agent hover:bg-hover' : 'text-secondary hover:text-primary hover:bg-hover'
                  }`}
                  aria-label={isBookmarked ? 'Remove bookmark' : 'Bookmark this page'}
                >
                  <Star size={13} />
                </button>
              </Tooltip>
              {bridge && (
                <Tooltip label="Screenshot">
                  <button onClick={() => void takeScreenshot()} className={iconButton} aria-label="Screenshot">
                    <Camera size={13} />
                  </button>
                </Tooltip>
              )}
            </>
          )}

          <Tooltip label="Menu">
            <button
              ref={menuButtonRef}
              onClick={() => { setDownloadsOpen(false); setMenuOpen((open) => !open) }}
              className={iconButton}
              aria-label="Browser menu"
              aria-expanded={menuOpen}
            >
              <DotsThreeVertical size={15} />
            </button>
          </Tooltip>
        </div>

        {menuOpen && (
          <BrowserMenu
            bookmarks={bookmarks}
            onNewTab={() => quietly({ kind: 'newTab' })}
            onNavigate={navigate}
            onOpenHistory={() => quietly({ kind: 'newTab', url: BROWSER_HISTORY_URL })}
            onOpenPasswordManager={() => quietly({ kind: 'newTab', url: BROWSER_PASSWORD_MANAGER_URL })}
            zoomPercent={Math.round(zoom * 100)}
            onZoomOut={() => setZoom(stepBrowserZoom(zoom, -1))}
            onZoomIn={() => setZoom(stepBrowserZoom(zoom, 1))}
            onZoomReset={() => setZoom(1)}
            viewport={viewport}
            onViewportChange={(next) => quietly({ kind: 'setViewport', viewport: next })}
            onClose={() => setMenuOpen(false)}
            triggerRef={menuButtonRef}
          />
        )}
        {downloadsOpen && downloads.length > 0 && (
          <BrowserDownloadsPopover
            downloads={downloads}
            onAction={(download, action) => { if (bridge) void actOnLocalDownload(bridge, download.id, action) }}
            onClose={() => setDownloadsOpen(false)}
            triggerRef={downloadButtonRef}
          />
        )}

        <div ref={containerRef} className="flex flex-1 items-start justify-start overflow-hidden relative">
          {loadError && (
            <ErrorOverlay title="Failed to load page" description={loadError} buttonLabel="Try Again" onRetry={reload} />
          )}
          {crashed && !loadError && (
            <ErrorOverlay
              title="This page crashed"
              description="The browser process for this panel stopped unexpectedly."
              buttonLabel="Reload Page"
              onRetry={reload}
            />
          )}

          {/* Guests share the view's transform, so the page and the agent
              overlay always use the same coordinates. */}
          {tabs.map((tab) => (isBrowserInternalPage(tab.url) || !shownTabs.current.has(tab.id) ? null : (
            <WebviewSlot
              key={`${panelId}:${partition}:${tab.id}`}
              tabId={tab.id}
              src={srcFor(tab.id)}
              partition={partition}
              active={tab.id === shownTabId}
              hidden={Boolean(loadError || crashed || isStartPage(tab.url))}
              viewport={viewport}
              displayScale={displayScale}
              onElement={onElement}
            />
          )))}

          {/* The start page covers the active tab's about:blank guest, which
              stays mounted so automation has a live target. */}
          {isStartPage(activeTab.url) && (
            <div className="absolute inset-0">
              <StartPage />
            </div>
          )}
          {activeTab.url === BROWSER_HISTORY_URL && (
            <BrowserHistoryPage
              history={history}
              onNavigate={navigate}
              onRemove={(url) => void browserData?.removeHistory(url)}
              onClear={() => void browserData?.clearHistory()}
            />
          )}
          {activeTab.url === BROWSER_PASSWORD_MANAGER_URL && <BrowserPasswordManagerPage workspaceId={workspaceId} />}

          {autofill && (
            <div
              ref={autofillRef}
              data-browser-autofill
              role="group"
              aria-label="Saved passwords"
              className={`absolute z-40 min-w-56 max-w-[calc(100%-1rem)] max-h-60 overflow-auto ${POPOVER_SURFACE}`}
              onKeyDown={(event) => { if (event.key === 'Escape') host.dismissAutofill() }}
            >
              <div className="flex items-center gap-2 border-b border-subtle px-3 py-2 text-xs text-muted">
                <Key size={13} />
                Saved passwords
              </div>
              {autofill.suggestions.map((suggestion) => (
                <button
                  key={suggestion.id}
                  className="flex w-full flex-col px-3 py-2 text-left hover:bg-hover"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => { void host.fillCredential(suggestion.id) }}
                >
                  <span className="max-w-72 truncate text-sm text-primary">{suggestion.username || 'Saved password'}</span>
                  <span className="max-w-72 truncate text-[11px] text-muted">{suggestion.origin}</span>
                </button>
              ))}
            </div>
          )}

          <AgentCursorOverlay cursor={agentCursor} scale={zoom * displayScale} />

          {screenshot && (
            <div className="absolute bottom-3 right-3 z-20 group cursor-grab active:cursor-grabbing" style={{ animation: 'screenshot-in 0.3s ease-out' }}>
              <div
                className="relative w-44 rounded-lg overflow-hidden shadow-2xl border border-subtle hover:border-strong transition-all"
                draggable={!!screenshot.ref}
                onMouseDown={(event) => event.stopPropagation()}
                onDragStart={(event) => {
                  if (!screenshot.ref) return event.preventDefault()
                  event.dataTransfer.effectAllowed = 'copy'
                  writeFileRefDrag(event.dataTransfer, { refs: [screenshot.ref] })
                  const image = new Image()
                  image.src = screenshot.dataUrl
                  event.dataTransfer.setDragImage(image, 20, 20)
                }}
              >
                <img src={screenshot.dataUrl} alt="Screenshot" className="w-full h-auto block pointer-events-none" draggable={false} />
                <button
                  onClick={() => { if (screenshotTimer.current) clearTimeout(screenshotTimer.current); setScreenshot(null) }}
                  className="absolute top-1 right-1 w-5 h-5 flex items-center justify-center rounded-full bg-black/60 text-primary hover:bg-black/80 text-xs opacity-0 group-hover:opacity-100 transition-opacity"
                  aria-label="Dismiss screenshot"
                >
                  ×
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
