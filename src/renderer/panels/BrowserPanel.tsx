// =============================================================================
// BrowserPanel — React component wrapping Electron's <webview> tag
// Provides URL bar with navigation controls and embedded web content.
// Ported from BrowserPanel.swift
// =============================================================================

import { useEffect, useRef, useState, useCallback } from 'react'
import { Globe, ArrowLeft, ArrowRight, ArrowClockwise, Camera, MagnifyingGlass } from '@phosphor-icons/react'
import { useSettingsStore } from '../stores/settingsStore'
import { useAppStore } from '../stores/appStore'
import { useCanvasStoreContext } from '../stores/CanvasStoreContext'
import { SEARCH_ENGINE_URLS } from '../../shared/types'
import type { BrowserPanelProps } from './types'
import { portalRegistry } from '../lib/portalRegistry'
import { isUrl, normalizeUrl } from './browserUrl'

// -----------------------------------------------------------------------------
// Type declarations for Electron's <webview> element
// -----------------------------------------------------------------------------

// Electron already declares webview in its types - we use 'as any' on the ref instead

interface WebviewElement extends HTMLElement {
  loadURL(url: string): void
  goBack(): void
  goForward(): void
  reload(): void
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
}: BrowserPanelProps) {
  const browserHomepage = useSettingsStore((s) => s.browserHomepage)
  const browserSearchEngine = useSettingsStore((s) => s.browserSearchEngine)
  const updatePanelTitle = useAppStore((s) => s.updatePanelTitle)
  const updatePanelUrl = useAppStore((s) => s.updatePanelUrl)

  const isFocused = useCanvasStoreContext((s) => s.focusedNodeId === nodeId)

  const rawInitialUrl = url || browserHomepage || 'https://www.google.com'
  const initialUrl = rawInitialUrl.startsWith('about:') ? rawInitialUrl : normalizeUrl(rawInitialUrl)

  // Stable src for the <webview> element — computed once at mount so React
  // never updates the attribute on re-render (which would re-navigate).
  const [webviewSrc] = useState(() => initialUrl)

  const webviewRef = useRef<WebviewElement | null>(null)
  const [currentUrl, setCurrentUrl] = useState(initialUrl)
  const [inputUrl, setInputUrl] = useState(initialUrl)
  const [canGoBack, setCanGoBack] = useState(false)
  const [canGoForward, setCanGoForward] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [screenshot, setScreenshot] = useState<{ dataUrl: string; filePath: string } | null>(null)
  const screenshotTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

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
  // Focus the webview when this panel becomes the focused node
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (!isFocused) return
    const webview = webviewRef.current
    if (!webview) return
    requestAnimationFrame(() => {
      webview.focus()
    })
  }, [isFocused])

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
      // errorCode -3 is a cancelled load (e.g. navigating away mid-load), ignore it
      if (event.errorCode === -3) return
      const description = event.errorDescription || 'Failed to load page'
      setLoadError(description)
      setIsLoading(false)
    }

    const onDidStartLoading = () => {
      setIsLoading(true)
      setLoadError(null)
    }

    const onDidStopLoading = () => {
      setIsLoading(false)
    }

    const onWillNavigate = (event: any) => {
      try {
        const { protocol } = new URL(event.url)
        if (protocol !== 'http:' && protocol !== 'https:' && protocol !== 'file:') {
          event.preventDefault()
          console.warn('[BrowserPanel] Blocked navigation to non-http(s)/file URL:', event.url)
        }
      } catch {
        event.preventDefault()
      }
    }

    const onNewWindow = (event: any) => {
      event.preventDefault()
      const url = event.url ?? event.detail?.url
      if (url) {
        console.log('[BrowserPanel] Blocked new-window for URL:', url)
      }
    }

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
    webview.addEventListener('will-navigate', onWillNavigate)
    webview.addEventListener('new-window', onNewWindow)

    return () => {
      try { portalRegistry.unregister(panelId) } catch { /* ignore */ }
      webview.removeEventListener('dom-ready', onDomReady)
      webview.removeEventListener('did-navigate', onDidNavigate)
      webview.removeEventListener('did-navigate-in-page', onDidNavigateInPage)
      webview.removeEventListener('page-title-updated', onPageTitleUpdated)
      webview.removeEventListener('did-fail-load', onDidFailLoad)
      webview.removeEventListener('did-start-loading', onDidStartLoading)
      webview.removeEventListener('did-stop-loading', onDidStopLoading)
      webview.removeEventListener('will-navigate', onWillNavigate)
      webview.removeEventListener('new-window', onNewWindow)
    }
  }, [panelId, workspaceId, updatePanelTitle, updatePanelUrl])

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <div className="flex flex-col w-full h-full">
      {/* URL bar */}
      <div className="h-10 flex items-center gap-2 px-2 bg-surface-4 border-b border-subtle shrink-0">
        {/* Navigation pill */}
        <div className="flex items-center h-7 rounded-full border border-subtle bg-surface-5 overflow-hidden">
          <button
            onClick={handleGoBack}
            disabled={!canGoBack}
            className="w-7 h-7 flex items-center justify-center hover:bg-hover disabled:opacity-30 disabled:hover:bg-transparent text-primary transition-colors"
            title="Back"
          >
            <ArrowLeft size={13} />
          </button>
          <div className="w-px h-3.5 bg-subtle" />
          <button
            onClick={handleGoForward}
            disabled={!canGoForward}
            className="w-7 h-7 flex items-center justify-center hover:bg-hover disabled:opacity-30 disabled:hover:bg-transparent text-primary transition-colors"
            title="Forward"
          >
            <ArrowRight size={13} />
          </button>
          <div className="w-px h-3.5 bg-subtle" />
          <button
            onClick={handleReload}
            className="w-7 h-7 flex items-center justify-center hover:bg-hover text-primary transition-colors"
            title="Reload"
          >
            <ArrowClockwise size={13} className={isLoading ? 'animate-spin' : ''} />
          </button>
        </div>

        {/* URL input */}
        <div className="flex-1 flex items-center h-7 rounded-full border border-subtle bg-surface-5 px-3 gap-2 focus-within:border-strong transition-colors">
          <MagnifyingGlass size={13} className="text-muted shrink-0" />
          <input
            type="text"
            value={inputUrl}
            onChange={(e) => setInputUrl(e.target.value)}
            onKeyDown={handleUrlBarKeyDown}
            className="flex-1 h-full bg-transparent text-sm text-primary outline-none placeholder:text-muted"
            placeholder="Enter URL or search..."
          />
        </div>

        {/* Screenshot tool */}
        <button
          onClick={handleScreenshot}
          className="w-7 h-7 flex items-center justify-center rounded-full border border-subtle bg-surface-5 hover:bg-hover text-primary transition-colors"
          title="Screenshot"
        >
          <Camera size={13} />
        </button>
      </div>

      {/* Webview + overlays container */}
      <div className="flex-1 relative">
        {/* Error state overlay */}
        {loadError && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-surface-4 text-secondary p-4 text-center z-10">
            <Globe size={32} className="mb-2 text-muted" />
            <p className="text-sm font-medium mb-1">Failed to load page</p>
            <p className="text-xs text-muted">{loadError}</p>
            <button
              onClick={handleReload}
              className="mt-3 px-3 py-1 text-xs rounded bg-surface-6 hover:bg-hover text-primary"
            >
              Try Again
            </button>
          </div>
        )}

        {/* Webview */}
        <webview
          ref={webviewRef as any}
          src={webviewSrc}
          className={`w-full h-full ${loadError ? 'hidden' : ''}`}
          partition={`persist:browser-${panelId}`}
        />

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
      </div>
    </div>
  )
}
