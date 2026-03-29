// =============================================================================
// BrowserPanel — React component wrapping Electron's <webview> tag
// Provides URL bar with navigation controls and embedded web content.
// Ported from BrowserPanel.swift
// =============================================================================

import { useEffect, useRef, useState, useCallback } from 'react'
import { Globe, ArrowLeft, ArrowRight, RotateCw } from 'lucide-react'
import { useSettingsStore } from '../stores/settingsStore'
import { useAppStore } from '../stores/appStore'
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
  addEventListener(type: string, listener: (event: any) => void): void
  removeEventListener(type: string, listener: (event: any) => void): void
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/** Check if input looks like a URL (contains "." and no spaces, or starts with http/https). */
function isUrl(input: string): boolean {
  const trimmed = input.trim()
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    return true
  }
  // Contains a dot and no spaces — likely a URL
  if (trimmed.includes('.') && !trimmed.includes(' ')) {
    return true
  }
  return false
}

/** Normalize a URL string, prepending https:// if no protocol present. */
function normalizeUrl(input: string): string {
  const trimmed = input.trim()
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    return trimmed
  }
  return `https://${trimmed}`
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

  const initialUrl = url || browserHomepage || 'https://www.google.com'

  const webviewRef = useRef<WebviewElement | null>(null)
  const [currentUrl, setCurrentUrl] = useState(initialUrl)
  const [inputUrl, setInputUrl] = useState(initialUrl)
  const [canGoBack, setCanGoBack] = useState(false)
  const [canGoForward, setCanGoForward] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

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

  const handleUrlBarKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      navigateTo(inputUrl)
    }
  }, [inputUrl, navigateTo])

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
    }

    const onDidNavigateInPage = (event: any) => {
      const url = event.url ?? webview.getURL()
      setCurrentUrl(url)
      setInputUrl(url)
      setCanGoBack(webview.canGoBack())
      setCanGoForward(webview.canGoForward())
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
  }, [panelId, workspaceId, updatePanelTitle])

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
        <input
          type="text"
          value={inputUrl}
          onChange={(e) => setInputUrl(e.target.value)}
          onKeyDown={handleUrlBarKeyDown}
          className="flex-1 h-6 bg-white/5 border border-white/10 rounded-md px-2 text-sm text-white/80 outline-none focus:border-white/25"
          placeholder="Enter URL or search..."
        />
      </div>

      {/* Error state overlay */}
      {loadError && (
        <div className="flex-1 flex flex-col items-center justify-center bg-[#1E1E24] text-white/60 p-4 text-center">
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
        className={`w-full flex-1 ${loadError ? 'hidden' : ''}`}
        allowpopups="true"
      />
    </div>
  )
}
