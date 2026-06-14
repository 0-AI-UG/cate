// =============================================================================
// BrowserPanel — React component wrapping Electron's <webview> tag
// Provides URL bar with navigation controls and embedded web content.
// Ported from BrowserPanel.swift
// =============================================================================

import { useEffect, useRef, useState, useCallback } from 'react'
import { Globe, ArrowLeft, ArrowRight, ArrowClockwise, Camera, MagnifyingGlass, ShieldCheck } from '@phosphor-icons/react'
import { useSettingsStore } from '../stores/settingsStore'
import { useAppStore } from '../stores/appStore'
import { useCanvasStoreContext } from '../stores/CanvasStoreContext'
import { SEARCH_ENGINE_URLS } from '../../shared/types'
import type { BrowserPanelProps } from './types'
import type { BrowserShortcutAction } from '../../shared/types'
import type { NativeContextMenuItem } from '../../shared/electron-api'
import { portalRegistry } from '../lib/portalRegistry'
import { isUrl, normalizeUrl } from './browserUrl'
import { pageLoadErrorFrom } from './browserLoadError'
import { Tooltip } from '../ui/Tooltip'

// -----------------------------------------------------------------------------
// Type declarations for Electron's <webview> element
// -----------------------------------------------------------------------------

// Electron already declares webview in its types - we use 'as any' on the ref instead

// Single shared persistent session for all browser panels (issue #220 bug 2).
// Previously the partition was keyed to the runtime panelId
// (`persist:browser-${panelId}`), but panelId is regenerated as a fresh UUID on
// every session restore, so each restart pointed at a brand-new empty cookie
// jar and logins were lost (with an orphaned partition leaking on disk per
// restart). A single stable partition keeps cookies/logins across restarts and
// panel re-creation. Trade-off: all browser panels share one cookie store.
const BROWSER_PARTITION = 'persist:browser-shared'

// Per-panel proxy support (issue #241). A panel with a proxy configured can't
// share the global `persist:browser-shared` session (setting a proxy there would
// affect every browser panel), so it gets its own persistent partition. The key
// is derived from the *proxy URL* — which is persisted in PanelState — rather
// than the ephemeral panelId, so the session is stable across restarts (no
// orphaned partitions, no lost cookies; this is the #220 regression the naive
// `persist:browser-${panelId}` approach would reintroduce). Trade-off: two
// panels configured with the same proxy share a cookie jar, which matches
// "same environment" semantics.
function stableHash(input: string): string {
  // FNV-1a 32-bit — small, dependency-free, good enough to key a partition name.
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}

/** The Electron session partition a browser panel should use given its proxy. */
function partitionFor(proxyUrl?: string): string {
  const trimmed = proxyUrl?.trim()
  return trimmed ? `persist:browser-proxy-${stableHash(trimmed)}` : BROWSER_PARTITION
}

interface WebviewElement extends HTMLElement {
  loadURL(url: string): void
  goBack(): void
  goForward(): void
  reload(): void
  reloadIgnoringCache(): void
  canGoBack(): boolean
  canGoForward(): boolean
  getURL(): string
  getTitle(): string
  getWebContentsId(): number
  addEventListener(type: string, listener: (event: any) => void): void
  removeEventListener(type: string, listener: (event: any) => void): void
}

// -----------------------------------------------------------------------------
// Component
// -----------------------------------------------------------------------------

export default function BrowserPanel({
  panelId,
  workspaceId,
  nodeId,
  url,
  proxyUrl,
}: BrowserPanelProps) {
  const browserHomepage = useSettingsStore((s) => s.browserHomepage)
  const browserSearchEngine = useSettingsStore((s) => s.browserSearchEngine)
  const updatePanelTitle = useAppStore((s) => s.updatePanelTitle)
  const updatePanelUrl = useAppStore((s) => s.updatePanelUrl)
  const updatePanelProxy = useAppStore((s) => s.updatePanelProxy)

  const isFocused = useCanvasStoreContext((s) => s.focusedNodeId === nodeId)

  const rawInitialUrl = url || browserHomepage || 'https://www.google.com'
  const initialUrl = rawInitialUrl.startsWith('about:') ? rawInitialUrl : normalizeUrl(rawInitialUrl)

  // Per-panel proxy (issue #241). Local state mirrors PanelState.proxyUrl; the
  // dialog updates both this (drives the session) and the store (persistence).
  const [activeProxy, setActiveProxy] = useState<string | undefined>(proxyUrl)
  const partition = partitionFor(activeProxy)
  // Set false while the proxy is being (re)configured so the <webview> only
  // attaches after the session's proxy is in place — the first request is then
  // already proxied. No-proxy panels never block.
  const [proxyReady, setProxyReady] = useState(!activeProxy)
  const [proxyDialogOpen, setProxyDialogOpen] = useState(false)
  const [proxyInput, setProxyInput] = useState('')

  // src for the <webview> element. Frozen across normal re-renders (changing it
  // would re-navigate), but intentionally re-seeded to the current page when the
  // partition changes so the remounted webview reopens where the user was.
  const [webviewSrc, setWebviewSrc] = useState(() => initialUrl)

  const webviewRef = useRef<WebviewElement | null>(null)
  const urlInputRef = useRef<HTMLInputElement | null>(null)
  // Mirror isFocused into a ref so the long-lived browser-shortcut subscription
  // reads the current value without re-subscribing on every focus change.
  const isFocusedRef = useRef(isFocused)
  const [currentUrl, setCurrentUrl] = useState(initialUrl)
  // Latest URL, read by the partition-change effect to re-seed the remounted
  // webview without making it a dependency (which would remount on every nav).
  const currentUrlRef = useRef(initialUrl)
  const [inputUrl, setInputUrl] = useState(initialUrl)
  const [canGoBack, setCanGoBack] = useState(false)
  const [canGoForward, setCanGoForward] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  // Distinct from loadError: the guest *renderer process* died (OOM / GPU
  // fault / native crash), not merely a failed navigation. Needs a reload to
  // respawn the renderer, so it gets its own overlay + recovery affordance.
  const [crashed, setCrashed] = useState(false)
  const [screenshot, setScreenshot] = useState<{ dataUrl: string; filePath: string } | null>(null)
  const screenshotTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // A dock tab stack renders only its active tab and REUSES this component
  // instance when the slot switches between two browser panels (same type, no
  // React key, so A and B reconcile as one instance). Our webview src + nav
  // state are seeded once at mount, so a reused slot would keep showing the
  // PREVIOUS browser's page — the "press +/split, then open the new tab and it
  // renders the first one" bug. Re-seed every per-panel field the moment the
  // slot switches panels. Done during render (React's "reset state when a prop
  // changes" pattern) so the panelId-keyed <webview> below mounts straight to
  // the new URL with no intermediate load of the old page. Editor/terminal
  // panels stay correct the same way, via their own identity props/effects.
  const [seededPanelId, setSeededPanelId] = useState(panelId)
  if (seededPanelId !== panelId) {
    setSeededPanelId(panelId)
    setActiveProxy(proxyUrl)
    setWebviewSrc(initialUrl)
    setCurrentUrl(initialUrl)
    setInputUrl(initialUrl)
    currentUrlRef.current = initialUrl
    setCanGoBack(false)
    setCanGoForward(false)
    setIsLoading(false)
    setLoadError(null)
    setCrashed(false)
    setScreenshot(null)
  }

  // -------------------------------------------------------------------------
  // Navigation helpers
  // -------------------------------------------------------------------------

  const navigateTo = useCallback((input: string) => {
    const webview = webviewRef.current
    if (!webview) return

    let targetUrl: string
    if (isUrl(input)) {
      targetUrl = normalizeUrl(input)
    } else {
      // Use search engine
      const searchBase = SEARCH_ENGINE_URLS[browserSearchEngine] ?? SEARCH_ENGINE_URLS.google
      targetUrl = searchBase + encodeURIComponent(input)
    }

    setLoadError(null)
    setIsLoading(true)
    setCurrentUrl(targetUrl)
    setInputUrl(targetUrl)
    // Persist immediately so a quick app close / workspace switch before
    // did-navigate fires still restores to the URL the user typed.
    updatePanelUrl(workspaceId, panelId, targetUrl)
    webview.loadURL(targetUrl)
  }, [browserSearchEngine, updatePanelUrl, workspaceId, panelId])

  const handleGoBack = useCallback(() => {
    webviewRef.current?.goBack()
  }, [])

  const handleGoForward = useCallback(() => {
    webviewRef.current?.goForward()
  }, [])

  const handleReload = useCallback(() => {
    webviewRef.current?.reload()
  }, [])

  const handleScreenshot = useCallback(async () => {
    const webview = webviewRef.current
    if (!webview) return
    const wcId = webview.getWebContentsId()
    if (!wcId) return

    const result = await window.electronAPI.webviewScreenshot(wcId)
    if (!result) return

    // Clear any existing timer
    if (screenshotTimerRef.current) clearTimeout(screenshotTimerRef.current)

    setScreenshot(result)

    // Auto-dismiss after 5 seconds
    screenshotTimerRef.current = setTimeout(() => {
      setScreenshot(null)
      screenshotTimerRef.current = null
    }, 5000)
  }, [])

  const handleScreenshotDragStart = useCallback((e: React.DragEvent) => {
    if (!screenshot) return
    // Set internal MIME so Canvas and TerminalPanel drop handlers accept it,
    // plus text/uri-list and text/plain so the path can be dropped into other
    // editable surfaces (URL bar, search boxes, external apps that accept text).
    try {
      e.dataTransfer.effectAllowed = 'copy'
      e.dataTransfer.setData('application/cate-file', screenshot.filePath)
      e.dataTransfer.setData('text/uri-list', `file://${screenshot.filePath}`)
      e.dataTransfer.setData('text/plain', screenshot.filePath)
      // Use the screenshot itself as the drag image so the cursor shows the
      // thumbnail mid-drag rather than the surrounding button chrome.
      const img = new Image()
      img.src = screenshot.dataUrl
      e.dataTransfer.setDragImage(img, 20, 20)
    } catch {
      // Older Electron — fall back to native OS drag with the file on disk.
      e.preventDefault()
      window.electronAPI.nativeFileDrag(screenshot.filePath)
    }
  }, [screenshot])

  const dismissScreenshot = useCallback(() => {
    if (screenshotTimerRef.current) clearTimeout(screenshotTimerRef.current)
    setScreenshot(null)
  }, [])

  const handleUrlBarKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      navigateTo(inputUrl)
    }
  }, [inputUrl, navigateTo])

  // -------------------------------------------------------------------------
  // Per-panel proxy (issue #241)
  // -------------------------------------------------------------------------

  // Keep currentUrlRef in step with currentUrl for the partition-change effect.
  useEffect(() => {
    currentUrlRef.current = currentUrl
  }, [currentUrl])

  // Configure the proxy on this panel's session before the webview attaches.
  // Re-runs whenever the proxy (and therefore the partition) changes. No-proxy
  // panels use the shared session as-is and never block on this.
  useEffect(() => {
    if (!activeProxy) {
      setProxyReady(true)
      return
    }
    let cancelled = false
    setProxyReady(false)
    window.electronAPI
      .browserSetProxy(partition, activeProxy)
      .then(() => { if (!cancelled) setProxyReady(true) })
      .catch((err) => {
        console.error('[BrowserPanel] Failed to configure proxy:', err)
        // Surface the failure but still let the page load (direct) rather than
        // leaving the panel permanently blank.
        if (!cancelled) {
          setLoadError('Failed to apply proxy settings')
          setProxyReady(true)
        }
      })
    return () => { cancelled = true }
  }, [partition, activeProxy])

  // When the partition changes (proxy added/removed/edited) the <webview> is
  // remounted via its key; re-seed its src to the current page so the user
  // stays where they were instead of jumping back to the initial URL.
  const didMountRef = useRef(false)
  useEffect(() => {
    if (!didMountRef.current) {
      didMountRef.current = true
      return
    }
    setWebviewSrc(currentUrlRef.current)
  }, [partition])

  const openProxyDialog = useCallback(() => {
    setProxyInput(activeProxy ?? '')
    setProxyDialogOpen(true)
  }, [activeProxy])

  const applyProxy = useCallback((next?: string) => {
    const value = next?.trim() || undefined
    setActiveProxy(value)
    updatePanelProxy(workspaceId, panelId, value)
    setProxyDialogOpen(false)
  }, [updatePanelProxy, workspaceId, panelId])

  const handleProxyContextMenu = useCallback(async (e: React.MouseEvent) => {
    e.preventDefault()
    const items: NativeContextMenuItem[] = [
      { id: 'configure', label: 'Configure Proxy…' },
    ]
    if (activeProxy) items.push({ id: 'clear', label: 'Clear Proxy (Direct)' })
    const id = await window.electronAPI.showContextMenu(items)
    if (id === 'configure') openProxyDialog()
    else if (id === 'clear') applyProxy(undefined)
  }, [activeProxy, openProxyDialog, applyProxy])

  // -------------------------------------------------------------------------
  // Browser navigation shortcuts (Cmd+R/[/]/L)
  // -------------------------------------------------------------------------

  const runBrowserAction = useCallback((action: BrowserShortcutAction) => {
    const webview = webviewRef.current
    switch (action) {
      case 'reload':
        webview?.reload()
        break
      case 'reloadHard':
        webview?.reloadIgnoringCache()
        break
      case 'back':
        webview?.goBack()
        break
      case 'forward':
        webview?.goForward()
        break
      case 'focusUrl': {
        const input = urlInputRef.current
        if (input) {
          input.focus()
          input.select()
        }
        break
      }
    }
  }, [])

  // Map a key event that lands on the panel chrome (e.g. the URL bar) to a
  // browser action. The webview-guest case is handled in the main process via
  // before-input-event (see webSecurity.ts), which forwards through
  // onBrowserShortcut below. Using e.code keeps this layout-independent.
  const handleChromeKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!(e.metaKey || e.ctrlKey)) return
    let action: BrowserShortcutAction | null = null
    switch (e.code) {
      case 'KeyR':
        action = e.shiftKey ? 'reloadHard' : 'reload'
        break
      case 'KeyL':
        if (!e.shiftKey) action = 'focusUrl'
        break
      case 'BracketLeft':
        if (!e.shiftKey) action = 'back'
        break
      case 'BracketRight':
        if (!e.shiftKey) action = 'forward'
        break
    }
    if (!action) return
    e.preventDefault()
    runBrowserAction(action)
  }, [runBrowserAction])

  // -------------------------------------------------------------------------
  // Focus the webview when this panel becomes the focused node
  // -------------------------------------------------------------------------

  useEffect(() => {
    isFocusedRef.current = isFocused
    if (!isFocused) return
    const webview = webviewRef.current
    if (!webview) return
    requestAnimationFrame(() => {
      webview.focus()
    })
  }, [isFocused])

  // Browser nav keys forwarded from the main process (fired while the webview
  // guest had keyboard focus) or from the Browser menu. Only the focused panel
  // reacts, so the key affects the browser the user is actually looking at.
  useEffect(() => {
    return window.electronAPI.onBrowserShortcut((action) => {
      if (!isFocusedRef.current) return
      runBrowserAction(action as BrowserShortcutAction)
    })
  }, [runBrowserAction])

  // -------------------------------------------------------------------------
  // Webview event listeners
  // -------------------------------------------------------------------------

  useEffect(() => {
    const webview = webviewRef.current
    if (!webview) return

    const onDidNavigate = (event: any) => {
      const url = event.url ?? webview.getURL()
      // Skip about:blank — it fires transiently when the webview guest
      // process spins up or during teardown. Persisting it would clobber
      // the real URL and break session restore / visibility-cull remount.
      if (url === 'about:blank') return
      setCurrentUrl(url)
      setInputUrl(url)
      setCanGoBack(webview.canGoBack())
      setCanGoForward(webview.canGoForward())
      setIsLoading(false)
      setLoadError(null)
      updatePanelUrl(workspaceId, panelId, url)
    }

    const onDidNavigateInPage = (event: any) => {
      const url = event.url ?? webview.getURL()
      if (url === 'about:blank') return
      setCurrentUrl(url)
      setInputUrl(url)
      setCanGoBack(webview.canGoBack())
      setCanGoForward(webview.canGoForward())
      updatePanelUrl(workspaceId, panelId, url)
    }

    const onPageTitleUpdated = (event: any) => {
      const title = event.title ?? webview.getTitle()
      if (title) {
        updatePanelTitle(workspaceId, panelId, title)
      }
    }

    const onDidFailLoad = (event: any) => {
      // Only main-frame failures are page errors; subframe failures (blocked
      // trackers, dead embeds) and aborted loads must not hide a working page.
      const description = pageLoadErrorFrom(event)
      if (description === null) return
      setLoadError(description)
      setIsLoading(false)
    }

    const onDidStartLoading = () => {
      setIsLoading(true)
      setLoadError(null)
      setCrashed(false)
    }

    // The guest renderer process died. Newer Electron fires `render-process-gone`
    // (with a reason); older builds fire the deprecated `crashed`. Handle both.
    const onRenderProcessGone = (event: any) => {
      const reason = event?.reason ?? 'crashed'
      if (reason === 'clean-exit') return // normal teardown, not a crash
      console.error('[BrowserPanel] webview renderer gone:', reason)
      setCrashed(true)
      setIsLoading(false)
    }
    const onCrashed = () => {
      console.error('[BrowserPanel] webview crashed')
      setCrashed(true)
      setIsLoading(false)
    }

    const onDidStopLoading = () => {
      setIsLoading(false)
    }

    // Navigation/new-window enforcement lives in the main process on the guest
    // webContents (will-navigate + setWindowOpenHandler in main/webSecurity.ts).
    // The matching <webview> DOM events here never let preventDefault() take
    // effect (and `new-window` was removed from the tag in Electron 22), so
    // handling them in the renderer is dead code that would falsely imply the
    // policy is enforced here.

    // Register with the portal registry once the guest webContents is live.
    // dom-ready is the first event for which getWebContentsId() returns a
    // stable id; we re-register on every dom-ready in case the webview was
    // re-attached after a navigation crash.
    const onDomReady = (): void => {
      try { portalRegistry.register(panelId, webview as any) } catch { /* ignore */ }
    }
    webview.addEventListener('dom-ready', onDomReady)

    webview.addEventListener('did-navigate', onDidNavigate)
    webview.addEventListener('did-navigate-in-page', onDidNavigateInPage)
    webview.addEventListener('page-title-updated', onPageTitleUpdated)
    webview.addEventListener('did-fail-load', onDidFailLoad)
    webview.addEventListener('did-start-loading', onDidStartLoading)
    webview.addEventListener('did-stop-loading', onDidStopLoading)
    webview.addEventListener('render-process-gone', onRenderProcessGone)
    webview.addEventListener('crashed', onCrashed)

    return () => {
      try { portalRegistry.unregister(panelId) } catch { /* ignore */ }
      webview.removeEventListener('dom-ready', onDomReady)
      webview.removeEventListener('did-navigate', onDidNavigate)
      webview.removeEventListener('did-navigate-in-page', onDidNavigateInPage)
      webview.removeEventListener('page-title-updated', onPageTitleUpdated)
      webview.removeEventListener('did-fail-load', onDidFailLoad)
      webview.removeEventListener('did-start-loading', onDidStartLoading)
      webview.removeEventListener('did-stop-loading', onDidStopLoading)
      webview.removeEventListener('render-process-gone', onRenderProcessGone)
      webview.removeEventListener('crashed', onCrashed)
    }
    // `partition` + `proxyReady` are deps so the listeners re-bind to the fresh
    // <webview> element after a proxy change remounts it (key={partition} +
    // the proxyReady gate); without them the new element would have no handlers.
  }, [panelId, workspaceId, updatePanelTitle, updatePanelUrl, partition, proxyReady])

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <div className="flex flex-col w-full h-full" onKeyDown={handleChromeKeyDown}>
      {/* URL bar */}
      <div className="h-10 flex items-center gap-2 px-2 bg-surface-4 border-b border-subtle shrink-0">
        {/* Navigation pill */}
        <div className="flex items-center h-7 rounded-full border border-subtle bg-surface-5 overflow-hidden">
          <Tooltip label="Back">
            <button
              onClick={handleGoBack}
              disabled={!canGoBack}
              className="w-7 h-7 flex items-center justify-center hover:bg-hover disabled:opacity-30 disabled:hover:bg-transparent text-primary transition-colors"
              aria-label="Back"
            >
              <ArrowLeft size={13} />
            </button>
          </Tooltip>
          <div className="w-px h-3.5 bg-subtle" />
          <Tooltip label="Forward">
            <button
              onClick={handleGoForward}
              disabled={!canGoForward}
              className="w-7 h-7 flex items-center justify-center hover:bg-hover disabled:opacity-30 disabled:hover:bg-transparent text-primary transition-colors"
              aria-label="Forward"
            >
              <ArrowRight size={13} />
            </button>
          </Tooltip>
          <div className="w-px h-3.5 bg-subtle" />
          <Tooltip label="Reload">
            <button
              onClick={handleReload}
              className="w-7 h-7 flex items-center justify-center hover:bg-hover text-primary transition-colors"
              aria-label="Reload"
            >
              <ArrowClockwise size={13} className={isLoading ? 'animate-spin' : ''} />
            </button>
          </Tooltip>
        </div>

        {/* URL input */}
        <div className="flex-1 flex items-center h-7 rounded-full border border-subtle bg-surface-5 px-3 gap-2 focus-within:border-strong transition-colors">
          <MagnifyingGlass size={13} className="text-muted shrink-0" />
          <input
            ref={urlInputRef}
            type="text"
            value={inputUrl}
            onChange={(e) => setInputUrl(e.target.value)}
            onKeyDown={handleUrlBarKeyDown}
            className="flex-1 h-full bg-transparent text-sm text-primary outline-none placeholder:text-muted"
            placeholder="Enter URL or search..."
          />
        </div>

        {/* Proxy tool — left-click configures, right-click offers clear. */}
        <Tooltip label={activeProxy ? `Proxy: ${activeProxy}` : 'Configure proxy'}>
          <button
            onClick={openProxyDialog}
            onContextMenu={handleProxyContextMenu}
            className={`w-7 h-7 flex items-center justify-center rounded-full border transition-colors ${
              activeProxy
                ? 'border-agent bg-agent/15 text-agent hover:bg-agent/25'
                : 'border-subtle bg-surface-5 hover:bg-hover text-primary'
            }`}
            aria-label={activeProxy ? `Proxy: ${activeProxy}` : 'Configure proxy'}
          >
            <ShieldCheck size={13} weight={activeProxy ? 'fill' : 'regular'} />
          </button>
        </Tooltip>

        {/* Screenshot tool */}
        <Tooltip label="Screenshot">
          <button
            onClick={handleScreenshot}
            className="w-7 h-7 flex items-center justify-center rounded-full border border-subtle bg-surface-5 hover:bg-hover text-primary transition-colors"
            aria-label="Screenshot"
          >
            <Camera size={13} />
          </button>
        </Tooltip>
      </div>

      {/* Webview + overlays container */}
      <div className="flex-1 relative">
        {/* Error state overlay */}
        {loadError && (
          <WebviewErrorOverlay
            title="Failed to load page"
            description={loadError}
            buttonLabel="Try Again"
            onRetry={handleReload}
          />
        )}

        {/* Crash state overlay — guest renderer process died (OOM/GPU/native). */}
        {crashed && !loadError && (
          <WebviewErrorOverlay
            title="This page crashed"
            description="The browser process for this panel stopped unexpectedly."
            buttonLabel="Reload Page"
            onRetry={handleReload}
          />
        )}

        {/* Webview — keyed by panelId + partition so a proxy change OR this slot
            being reused for a different browser panel cleanly remounts it with a
            fresh webContents (no inherited page or history). Only rendered once
            the proxy session is configured. */}
        {proxyReady && (
          <webview
            key={`${panelId}:${partition}`}
            ref={webviewRef as any}
            src={webviewSrc}
            className={`w-full h-full ${loadError || crashed ? 'hidden' : ''}`}
            partition={partition}
          />
        )}

        {/* Screenshot thumbnail */}
        {screenshot && (
          <div
            className="absolute bottom-3 right-3 z-20 group cursor-grab active:cursor-grabbing"
            style={{ animation: 'screenshot-in 0.3s ease-out' }}
          >
            <div
              className="relative w-44 rounded-lg overflow-hidden shadow-2xl border border-subtle hover:border-strong transition-all"
              draggable
              onMouseDown={(e) => e.stopPropagation()}
              onDragStart={handleScreenshotDragStart}
            >
              <img
                src={screenshot.dataUrl}
                alt="Screenshot"
                className="w-full h-auto block pointer-events-none"
                draggable={false}
              />
              <button
                onClick={dismissScreenshot}
                className="absolute top-1 right-1 w-5 h-5 flex items-center justify-center rounded-full bg-black/60 text-primary hover:bg-black/80 text-xs opacity-0 group-hover:opacity-100 transition-opacity"
              >
                ×
              </button>
            </div>
          </div>
        )}

        {/* Proxy configuration dialog */}
        {proxyDialogOpen && (
          <ProxyDialog
            initialValue={proxyInput}
            onCancel={() => setProxyDialogOpen(false)}
            onSave={applyProxy}
          />
        )}
      </div>
    </div>
  )
}

// -----------------------------------------------------------------------------
// Webview error/crash overlay
// -----------------------------------------------------------------------------

/** Full-bleed overlay shown when the webview fails to load or its process crashes. */
function WebviewErrorOverlay({
  title,
  description,
  buttonLabel,
  onRetry,
}: {
  title: string
  description: React.ReactNode
  buttonLabel: string
  onRetry: () => void
}) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center bg-surface-4 text-secondary p-4 text-center z-10">
      <Globe size={32} className="mb-2 text-muted" />
      <p className="text-sm font-medium mb-1">{title}</p>
      <p className="text-xs text-muted">{description}</p>
      <button
        onClick={onRetry}
        className="mt-3 px-3 py-1 text-xs rounded bg-surface-6 hover:bg-hover text-primary"
      >
        {buttonLabel}
      </button>
    </div>
  )
}

// -----------------------------------------------------------------------------
// Proxy configuration dialog
// -----------------------------------------------------------------------------

/** Inline monospace token used in the proxy dialog helper text. */
function Token({ children }: { children: React.ReactNode }) {
  return <span className="font-mono text-secondary">{children}</span>
}

function ProxyDialog({
  initialValue,
  onCancel,
  onSave,
}: {
  initialValue: string
  onCancel: () => void
  onSave: (value?: string) => void
}) {
  const [value, setValue] = useState(initialValue)
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  const submit = () => onSave(value)

  return (
    <div
      className="absolute inset-0 z-30 flex items-center justify-center bg-black/50 backdrop-blur-[2px]"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel() }}
    >
      <div className="w-[23rem] max-w-[90%] rounded-xl border border-subtle bg-surface-4 shadow-2xl p-5 animate-sidebar-view-in">
        <h2 className="text-sm font-medium text-primary">Configure Proxy</h2>

        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); submit() }
            else if (e.key === 'Escape') { e.preventDefault(); onCancel() }
          }}
          className="mt-3 w-full h-10 rounded-lg border border-subtle bg-surface-5 px-3 text-sm text-primary outline-none focus:border-strong placeholder:text-muted font-mono transition-colors"
          placeholder="http://user:pass@proxy.company.com:8080"
        />
        <p className="mt-2 text-[11px] leading-relaxed text-muted">
          Leave empty for a direct connection. Supports <Token>user:pass@</Token> auth,{' '}
          <Token>pac://</Token> scripts, and <Token>;bypass=</Token> lists.
        </p>

        <div className="mt-5 flex items-center justify-between">
          <button
            onClick={() => onSave(undefined)}
            className="text-xs text-muted hover:text-secondary transition-colors"
          >
            Clear (Direct)
          </button>
          <div className="flex gap-2">
            <button
              onClick={onCancel}
              className="px-3.5 py-1.5 text-xs rounded-lg text-secondary hover:bg-hover transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={submit}
              className="px-3.5 py-1.5 text-xs font-medium rounded-lg bg-agent text-white hover:opacity-90 transition-opacity"
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
