// =============================================================================
// BrowserPanel — React component wrapping Electron's <webview> tag
// Provides URL bar with navigation controls and embedded web content.
// Ported from BrowserPanel.swift
// =============================================================================

import { useEffect, useRef, useState, useCallback } from 'react'
import { Globe, ArrowLeft, ArrowRight, RotateCw, Camera } from 'lucide-react'
import { useSettingsStore } from '../stores/settingsStore'
import { useAppStore } from '../stores/appStore'
import { useCanvasStoreContext } from '../stores/CanvasStoreContext'
import { SEARCH_ENGINE_URLS } from '../../shared/types'
import type { BrowserPanelProps } from './types'

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
// Helpers
// -----------------------------------------------------------------------------

/** Check if input looks like a URL rather than a search query. */
function isUrl(input: string): boolean {
  const trimmed = input.trim()
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    return true
  }
  // Has spaces — definitely a search query
  if (trimmed.includes(' ')) {
    return false
  }
  // Contains a dot — likely a domain (e.g. "example.com", "192.168.1.1")
  if (trimmed.includes('.')) {
    return true
  }
  // "localhost" or "localhost:port"
  if (/^localhost(:\d+)?(\/.*)?$/.test(trimmed)) {
    return true
  }
  // Explicit port on any host (e.g. "myhost:3000")
  if (/^[\w-]+(:\d+)(\/.*)?$/.test(trimmed)) {
    return true
  }
  return false
}

/** Normalize a URL string, prepending a protocol if none present.
 *  Uses http:// for localhost/127.0.0.1/[::1], https:// for everything else.
 *  Also downgrades https:// to http:// for local addresses. */
function normalizeUrl(input: string): string {
  const trimmed = input.trim()
  if (trimmed.startsWith('about:')) return trimmed
  // Downgrade https to http for local addresses
  if (/^https:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/.test(trimmed)) {
    return trimmed.replace('https://', 'http://')
  }
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    return trimmed
  }
  const isLocal = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/.test(trimmed)
  return `${isLocal ? 'http' : 'https'}://${trimmed}`
}

// -----------------------------------------------------------------------------
// Component
// -----------------------------------------------------------------------------

export default function BrowserPanel({
  panelId,
  workspaceId,
  nodeId,
  url,
  zoomLevel = 1,
}: BrowserPanelProps) {
  const browserHomepage = useSettingsStore((s) => s.browserHomepage)
  const browserSearchEngine = useSettingsStore((s) => s.browserSearchEngine)
  const updatePanelTitle = useAppStore((s) => s.updatePanelTitle)
  const updatePanelUrl = useAppStore((s) => s.updatePanelUrl)

  const isFocused = useCanvasStoreContext((s) => s.focusedNodeId === nodeId)

  const rawInitialUrl = url || browserHomepage || 'https://www.google.com'
  const initialUrl = rawInitialUrl.startsWith('about:') ? rawInitialUrl : normalizeUrl(rawInitialUrl)

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
    webview.loadURL(targetUrl)
  }, [browserSearchEngine])

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
    e.preventDefault()
    window.electronAPI.nativeFileDrag(screenshot.filePath)
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

    webview.addEventListener('did-navigate', onDidNavigate)
    webview.addEventListener('did-navigate-in-page', onDidNavigateInPage)
    webview.addEventListener('page-title-updated', onPageTitleUpdated)
    webview.addEventListener('did-fail-load', onDidFailLoad)
    webview.addEventListener('did-start-loading', onDidStartLoading)
    webview.addEventListener('did-stop-loading', onDidStopLoading)

    return () => {
      webview.removeEventListener('did-navigate', onDidNavigate)
      webview.removeEventListener('did-navigate-in-page', onDidNavigateInPage)
      webview.removeEventListener('page-title-updated', onPageTitleUpdated)
      webview.removeEventListener('did-fail-load', onDidFailLoad)
      webview.removeEventListener('did-start-loading', onDidStartLoading)
      webview.removeEventListener('did-stop-loading', onDidStopLoading)
    }
  }, [panelId, workspaceId, updatePanelTitle, updatePanelUrl])

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <div className="flex flex-col w-full h-full">
      {/* URL bar */}
      <div className="h-8 flex items-center gap-1 px-1 bg-[#1E1E24] border-b border-white/10 shrink-0">
        <button
          onClick={handleGoBack}
          disabled={!canGoBack}
          className="w-5 h-5 flex items-center justify-center rounded hover:bg-white/10 disabled:opacity-30 text-white/70"
          title="Back"
        >
          <ArrowLeft size={14} />
        </button>
        <button
          onClick={handleGoForward}
          disabled={!canGoForward}
          className="w-5 h-5 flex items-center justify-center rounded hover:bg-white/10 disabled:opacity-30 text-white/70"
          title="Forward"
        >
          <ArrowRight size={14} />
        </button>
        <button
          onClick={handleReload}
          className="w-5 h-5 flex items-center justify-center rounded hover:bg-white/10 text-white/70"
          title="Reload"
        >
          <RotateCw size={14} className={isLoading ? 'animate-spin' : ''} />
        </button>
        <button
          onClick={handleScreenshot}
          className="w-5 h-5 flex items-center justify-center rounded hover:bg-white/10 text-white/70"
          title="Screenshot"
        >
          <Camera size={14} />
        </button>
        <input
          type="text"
          value={inputUrl}
          onChange={(e) => setInputUrl(e.target.value)}
          onKeyDown={handleUrlBarKeyDown}
          className="flex-1 h-6 bg-white/5 border border-white/10 rounded-md px-2 text-sm text-white/80 outline-none focus:border-white/25"
          placeholder="Enter URL or search..."
        />
      </div>

      {/* Webview + overlays container */}
      <div className="flex-1 relative">
        {/* Error state overlay */}
        {loadError && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-[#1E1E24] text-white/60 p-4 text-center z-10">
            <Globe size={32} className="mb-2 text-white/30" />
            <p className="text-sm font-medium mb-1">Failed to load page</p>
            <p className="text-xs text-white/40">{loadError}</p>
            <button
              onClick={handleReload}
              className="mt-3 px-3 py-1 text-xs rounded bg-white/10 hover:bg-white/15 text-white/70"
            >
              Try Again
            </button>
          </div>
        )}

        {/* Webview */}
        <webview
          ref={webviewRef as any}
          src={initialUrl}
          className={`w-full h-full ${loadError ? 'hidden' : ''}`}
          allowpopups={true as any}
        />

        {/* Screenshot thumbnail */}
        {screenshot && (
          <div
            className="absolute bottom-3 right-3 z-20 group cursor-grab active:cursor-grabbing"
            style={{ animation: 'screenshot-in 0.3s ease-out' }}
          >
            <div
              className="relative w-44 rounded-lg overflow-hidden shadow-2xl border border-white/15 hover:border-white/30 transition-all"
              draggable
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
                className="absolute top-1 right-1 w-5 h-5 flex items-center justify-center rounded-full bg-black/60 text-white/80 hover:bg-black/80 text-xs opacity-0 group-hover:opacity-100 transition-opacity"
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
