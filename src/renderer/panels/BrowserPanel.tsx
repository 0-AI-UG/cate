// =============================================================================
// BrowserPanel — React chrome around a main-owned WebContentsView.
// Provides URL bar with navigation controls and isolated embedded content.
// Ported from BrowserPanel.swift
// =============================================================================

import { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import { Globe, ArrowLeft, ArrowRight, ArrowClockwise, ArrowUpRight, Camera, Key, Star, DotsThreeVertical } from '@phosphor-icons/react'
import { useSettingsStore } from '../stores/settingsStore'
import { useAppStore } from '../stores/appStore'
import { useBrowserStore } from '../stores/browserStore'
import { useOptionalCanvasStoreApi, useOptionalCanvasStoreContext } from '../stores/CanvasStoreContext'
import { focusedNodeId } from '../stores/canvas/selectionModel'
import { SEARCH_ENGINE_URLS, BROWSER_NEW_TAB_URL, isStartPageUrl } from '../../shared/types'
import { UrlSuggestions } from './UrlSuggestions'
import { StartPage } from './StartPage'
import { AgentCursorOverlay } from './AgentCursorOverlay'
import { BrowserMenu } from './BrowserMenu'
import { BrowserPasswordManagerPage } from './BrowserPasswordManagerPage'
import { BrowserTabStrip } from './BrowserTabStrip'
import type { BrowserCredentialSuggestion, BrowserTab } from '../../shared/types'
import type { BrowserPanelProps } from './types'
import type { BrowserShortcutAction } from '../../shared/types'
import { portalRegistry, type BrowserViewport } from '../lib/portalRegistry'
import { releaseAgentCursor, subscribeBrowserContentChanged } from '../lib/browser/agentCursor'
import { writeCateFileDrag } from '../drag/fileDragPayload'
import { isUrl, normalizeUrl } from './browserUrl'
import { pageLoadErrorFrom } from './browserLoadError'
import { NativeBrowserView } from '../lib/browser/nativeBrowserView'
import { Tooltip } from '../ui/Tooltip'
import {
  BROWSER_PASSWORD_MANAGER_URL,
  browserInternalPageTitle,
  isBrowserInternalPage,
} from '../lib/browser/internalPages'

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

/** Stable-enough unique id for a browser tab. */
function makeTabId(): string {
  return `tab-${crypto.randomUUID()}`
}

function addressBarValue(url: string): string {
  return isStartPageUrl(url) ? '' : url
}

function webviewSeedUrl(url: string): string {
  return isStartPageUrl(url) ? 'about:blank' : url
}

type WebviewElement = NativeBrowserView

const BROWSER_ZOOM_FACTORS = [
  0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5,
] as const

const COMPACT_BROWSER_SCALE = 0.75

export function browserViewportScale(
  viewport: BrowserViewport,
  container: { width: number; height: number },
): number {
  if (viewport.preset === 'compact') return COMPACT_BROWSER_SCALE
  if (container.width <= 0 || container.height <= 0) return 0.5
  return Math.min(1, container.width / viewport.width, container.height / viewport.height)
}

/** Native content is sized in window coordinates, outside the renderer's CSS
 * transform tree, so reproduce every scale that would have affected a webview. */
export function browserNativeZoomFactor(
  browserZoom: number,
  viewportScale: number,
  canvasZoom: number,
): number {
  return browserZoom * viewportScale * canvasZoom
}

// Browser guests are isolated documents, so the renderer's global scrollbar
// styles do not reach them. Inject a visible horizontal thumb using the current
// Cate theme; this leaves each page's overflow behavior intact.
export function browserGuestScrollbarCss(): string {
  const vars = getComputedStyle(document.documentElement)
  const thumb = vars.getPropertyValue('--scrollbar-thumb').trim() || 'rgba(255,255,255,0.15)'
  const hover = vars.getPropertyValue('--scrollbar-thumb-hover').trim() || 'rgba(255,255,255,0.25)'
  return (
    '::-webkit-scrollbar{width:8px;height:8px}' +
    '::-webkit-scrollbar-track{background:transparent}' +
    `::-webkit-scrollbar-thumb{background:${thumb};border-radius:9999px}` +
    `::-webkit-scrollbar-thumb:hover{background:${hover}}` +
    '::-webkit-scrollbar-corner{background:transparent}'
  )
}

interface AutofillPopup {
  targetId: string
  rect: { left: number; bottom: number; width: number; height: number }
  suggestions: BrowserCredentialSuggestion[]
}

function BrowserWebviewSlot({
  panelId,
  tabId,
  src,
  partition,
  active,
  hidden,
  viewport,
  displayScale,
  browserZoomFactor,
  canvasBacked,
  focused,
  onElement,
}: {
  panelId: string
  tabId: string
  src: string
  partition: string
  active: boolean
  hidden: boolean
  viewport: BrowserViewport
  displayScale: number
  browserZoomFactor: number
  canvasBacked: boolean
  focused: boolean
  onElement(tabId: string, element: WebviewElement | null): void
}) {
  const canvasStoreApi = useOptionalCanvasStoreApi()
  const frameRef = useRef<HTMLDivElement | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const previewRef = useRef<string | null>(null)
  const previewCaptureInFlightRef = useRef(false)
  const previewCaptureRequestedRef = useRef(false)
  const previewGenerationRef = useRef(0)
  const previewCapturedGenerationRef = useRef(-1)
  const previewModeRef = useRef(false)
  const nativeVisibleRef = useRef(false)
  const capturePreviewRef = useRef<() => void>(() => {})
  const [view, setView] = useState<NativeBrowserView | null>(null)
  const scheduleLayoutRef = useRef<() => void>(() => {})
  const layoutInputsRef = useRef({
    active,
    hidden,
    displayScale,
    browserZoomFactor,
    canvasBacked,
    focused,
  })
  layoutInputsRef.current = {
    active,
    hidden,
    displayScale,
    browserZoomFactor,
    canvasBacked,
    focused,
  }

  useEffect(() => {
    let cancelled = false
    let created: NativeBrowserView | null = null
    void NativeBrowserView.create(panelId, partition).then((next) => {
      if (!next || cancelled) {
        next?.dispose()
        return
      }
      created = next
      setView(next)
      onElement(tabId, next)
      requestAnimationFrame(() => {
        if (!cancelled) next.loadURL(src)
      })
    })
    return () => {
      cancelled = true
      onElement(tabId, null)
      created?.dispose()
    }
  }, [panelId, partition, tabId])

  const capturePreview = useCallback(() => {
    if (!view || previewCapturedGenerationRef.current === previewGenerationRef.current) return
    if (previewCaptureInFlightRef.current) {
      previewCaptureRequestedRef.current = true
      return
    }
    const generation = previewGenerationRef.current
    previewCaptureInFlightRef.current = true
    previewCaptureRequestedRef.current = false
    void view.capturePage().then((dataUrl) => {
      if (dataUrl && generation === previewGenerationRef.current) {
        previewRef.current = dataUrl
        previewCapturedGenerationRef.current = generation
        setPreview(dataUrl)
      }
    }).catch(() => {}).finally(() => {
      previewCaptureInFlightRef.current = false
      if (previewCaptureRequestedRef.current) {
        previewCaptureRequestedRef.current = false
        queueMicrotask(() => capturePreviewRef.current())
      }
    })
  }, [view])
  capturePreviewRef.current = capturePreview

  useEffect(() => subscribeBrowserContentChanged(panelId, () => {
    previewGenerationRef.current += 1
    const inputs = layoutInputsRef.current
    if (inputs.active && (inputs.hidden || (inputs.canvasBacked && !inputs.focused))) {
      capturePreview()
    }
  }), [panelId, capturePreview])

  useEffect(() => {
    if (!view) return
    const markPreviewStale = () => {
      previewGenerationRef.current += 1
    }
    const captureIfHidden = () => {
      const inputs = layoutInputsRef.current
      if (inputs.active && (inputs.hidden || (inputs.canvasBacked && !inputs.focused))) {
        capturePreview()
      }
    }
    view.addEventListener('did-start-loading', markPreviewStale)
    view.addEventListener('did-stop-loading', captureIfHidden)
    return () => {
      view.removeEventListener('did-start-loading', markPreviewStale)
      view.removeEventListener('did-stop-loading', captureIfHidden)
    }
  }, [view, capturePreview])

  // A native WebContentsView cannot participate in the canvas's CSS transform.
  // Track the placeholder's final screen rect and hide the native surface while
  // a gesture is active; the last captured frame remains in the DOM and scales
  // with the rest of the canvas until the gesture settles. Layout sync is
  // event-driven so an idle browser does no renderer-side polling.
  useEffect(() => {
    if (!view) return
    let raf = 0
    let last = ''
    let lastLayout: Parameters<NativeBrowserView['setLayout']>[0] | null = null
    let canvasMotion = false
    let canvasMotionTimer: ReturnType<typeof setTimeout> | null = null

    const setLayout = (layout: Parameters<NativeBrowserView['setLayout']>[0]) => {
      const signature = JSON.stringify(layout)
      if (signature === last) return
      last = signature
      lastLayout = layout
      if (nativeVisibleRef.current && !layout.visible && !previewModeRef.current) {
        previewGenerationRef.current += 1
        capturePreview()
      }
      nativeVisibleRef.current = layout.visible
      view.setLayout(layout)
    }

    const sync = () => {
      raf = 0
      const frame = frameRef.current
      if (frame) {
        const inputs = layoutInputsRef.current
        const canvasZoom = inputs.canvasBacked
          ? canvasStoreApi?.getState().zoomLevel ?? 1
          : 1
        if (!inputs.active) {
          const rect = frame.getBoundingClientRect()
          setLayout({
            rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
            rendererSize: { width: window.innerWidth, height: window.innerHeight },
            visible: false,
            zoomFactor: browserNativeZoomFactor(
              inputs.browserZoomFactor,
              inputs.displayScale,
              canvasZoom,
            ),
          })
          return
        }

        const gesture = document.body.classList.contains('canvas-interacting')
          || document.body.classList.contains('canvas-dragging')
          || document.body.classList.contains('canvas-zooming')

        // The DOM preview follows canvas transforms while a gesture is active.
        // Hide the native surface once, then defer its expensive bounds/zoom
        // updates until the gesture settles instead of relaying every frame to
        // main and forcing Chromium to rerasterize the page each time.
        if (gesture || canvasMotion) {
          capturePreview()
          const rect = frame.getBoundingClientRect()
          setLayout({
            rect: lastLayout?.rect ?? { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
            rendererSize: { width: window.innerWidth, height: window.innerHeight },
            visible: false,
            zoomFactor: lastLayout?.zoomFactor ?? browserNativeZoomFactor(
              inputs.browserZoomFactor,
              inputs.displayScale,
              canvasZoom,
            ),
          })
          return
        }

        const rect = frame.getBoundingClientRect()
        const fullyOnscreen = rect.left >= 0
          && rect.top >= 0
          && rect.right <= window.innerWidth
          && rect.bottom <= window.innerHeight
        const obscuredByChrome = [...document.querySelectorAll<HTMLElement>('[data-toolbar-card], [role="dialog"]')]
          .some((element) => {
            const overlay = element.getBoundingClientRect()
            return overlay.width > 0
              && overlay.height > 0
              && rect.left < overlay.right
              && rect.right > overlay.left
              && rect.top < overlay.bottom
              && rect.bottom > overlay.top
          })
        const visible = inputs.active
          && !inputs.hidden
          && (!inputs.canvasBacked || inputs.focused)
          && fullyOnscreen
          && !obscuredByChrome
          && rect.width > 1
          && rect.height > 1
        const layout = {
          rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
          rendererSize: { width: window.innerWidth, height: window.innerHeight },
          visible,
          zoomFactor: browserNativeZoomFactor(
            inputs.browserZoomFactor,
            inputs.displayScale,
            canvasZoom,
          ),
        }
        setLayout(layout)
      }
    }

    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(sync)
    }
    scheduleLayoutRef.current = schedule

    const resizeObserver = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(schedule)
    if (frameRef.current) resizeObserver?.observe(frameRef.current)

    const bodyClassObserver = new MutationObserver(schedule)
    bodyClassObserver.observe(document.body, {
      attributes: true,
      attributeFilter: ['class'],
    })

    // Renderer overlays are usually portalled outside the panel. Child-list
    // changes are enough to notice them without watching every class/style
    // mutation in the application.
    const overlayObserver = new MutationObserver(schedule)
    overlayObserver.observe(document.body, {
      childList: true,
      subtree: true,
    })

    // Canvas/world/node positioning is applied imperatively through ancestor
    // styles. Observe just this slot's ancestor chain so auto-layout and shell
    // transitions update native bounds without a global animation-frame loop.
    const geometryObserver = new MutationObserver(schedule)
    let ancestor = frameRef.current?.parentElement ?? null
    while (ancestor && ancestor !== document.body) {
      geometryObserver.observe(ancestor, {
        attributes: true,
        attributeFilter: ['class', 'style'],
      })
      ancestor = ancestor.parentElement
    }

    const unsubscribeCanvas = active && canvasBacked && canvasStoreApi
      ? canvasStoreApi.subscribe((state, previous) => {
          if (state.zoomLevel === previous.zoomLevel && state.viewportOffset === previous.viewportOffset) return
          canvasMotion = true
          schedule()
          if (canvasMotionTimer) clearTimeout(canvasMotionTimer)
          canvasMotionTimer = setTimeout(() => {
            canvasMotionTimer = null
            canvasMotion = false
            schedule()
          }, 80)
        })
      : () => {}

    window.addEventListener('resize', schedule)
    window.addEventListener('scroll', schedule, true)
    schedule()

    return () => {
      scheduleLayoutRef.current = () => {}
      if (raf) cancelAnimationFrame(raf)
      if (canvasMotionTimer) clearTimeout(canvasMotionTimer)
      resizeObserver?.disconnect()
      bodyClassObserver.disconnect()
      overlayObserver.disconnect()
      geometryObserver.disconnect()
      unsubscribeCanvas()
      window.removeEventListener('resize', schedule)
      window.removeEventListener('scroll', schedule, true)
    }
  }, [view, active, canvasBacked, canvasStoreApi, capturePreview])

  useEffect(() => {
    scheduleLayoutRef.current()
    const previewMode = active && (hidden || (canvasBacked && !focused))
    if (previewMode && !previewModeRef.current) previewGenerationRef.current += 1
    previewModeRef.current = previewMode
    if (previewMode) capturePreview()
  }, [active, hidden, displayScale, browserZoomFactor, canvasBacked, focused, capturePreview])

  const fixed = viewport.preset !== 'compact'
  const frameStyle = fixed
    ? { width: viewport.width * displayScale, height: viewport.height * displayScale }
    : { width: '100%', height: '100%' }
  const webviewStyle = fixed
    ? { width: viewport.width, height: viewport.height }
    : { width: `${100 / displayScale}%`, height: `${100 / displayScale}%` }

  return (
    <div
      ref={frameRef}
      data-browser-native-view
      data-browser-src={src}
      data-browser-partition={partition}
      className={`${active ? 'relative' : 'absolute inset-0 invisible pointer-events-none'} overflow-hidden bg-surface-0`}
      style={frameStyle}
    >
      {preview && (
        <img
          src={preview}
          aria-hidden
          className="absolute left-0 top-0 h-full w-full object-fill pointer-events-none"
        />
      )}
      {!preview && <div style={webviewStyle} />}
    </div>
  )
}

// -----------------------------------------------------------------------------
// Component
// -----------------------------------------------------------------------------

export default function BrowserPanel({
  panelId,
  workspaceId,
  nodeId,
  tabs: tabsProp,
  activeTabId: activeTabIdProp,
}: BrowserPanelProps) {
  const browserHomepage = useSettingsStore((s) => s.browserHomepage)
  const browserSearchEngine = useSettingsStore((s) => s.browserSearchEngine)
  const browserProxyUrl = useSettingsStore((s) => s.browserProxyUrl)
  const browserNewTabBehavior = useSettingsStore((s) => s.browserNewTabBehavior)
  const updatePanelTitle = useAppStore((s) => s.updatePanelTitle)
  const updateBrowserActiveTabUrl = useAppStore((s) => s.updateBrowserActiveTabUrl)
  const updatePanelTabs = useAppStore((s) => s.updatePanelTabs)

  // Global browser history + bookmarks (shared across all panels/windows).
  const recordVisit = useBrowserStore((s) => s.recordVisit)
  const bookmarks = useBrowserStore((s) => s.bookmarks)
  const toggleBookmark = useBrowserStore((s) => s.toggleBookmark)
  const querySuggestions = useBrowserStore((s) => s.querySuggestions)

  // Optional: a panel docked in a detached dock window has no CanvasStoreProvider
  // (no canvas node to be focused), so treat that as not-canvas-focused.
  const isFocused = useOptionalCanvasStoreContext((s) => focusedNodeId(s) === nodeId, false)
  const canvasStoreApi = useOptionalCanvasStoreApi()
  // Main-window docks share the root CanvasStoreProvider but have no nodeId;
  // only a panel inside an actual CanvasNode follows canvas focus/zoom.
  const canvasBacked = Boolean(nodeId && canvasStoreApi)

  // --- Tabs -----------------------------------------------------------------
  // Seed once from the current persisted schema. There is deliberately no
  // URL fallback: tabs + activeTabId are the only navigation authority.
  const seedTabs = useRef<{ tabs: BrowserTab[]; activeId: string } | null>(null)
  if (seedTabs.current === null) {
    // A legacy panel persisted before the tabs schema (migrations were removed)
    // arrives with tabs/activeTabId undefined. Treat that like any other invalid
    // state so the PanelErrorBoundary renders a clean error tile instead of an
    // unguarded `undefined.length` TypeError.
    if (!tabsProp?.length || !tabsProp.some((tab) => tab.id === activeTabIdProp)) {
      throw new Error(`Browser panel ${panelId} has invalid tab state`)
    }
    seedTabs.current = { tabs: tabsProp, activeId: activeTabIdProp }
  }
  const [tabs, setTabs] = useState<BrowserTab[]>(seedTabs.current.tabs)
  const [activeTabId, setActiveTabId] = useState<string>(seedTabs.current.activeId)
  const initialUrl = seedTabs.current.tabs.find((tab) => tab.id === seedTabs.current!.activeId)!.url
  const activeTabIdRef = useRef(activeTabId)
  useEffect(() => { activeTabIdRef.current = activeTabId }, [activeTabId])

  // What a new tab opens, per setting.
  const newTabUrl = useCallback((): string => {
    if (browserNewTabBehavior === 'homepage') return browserHomepage || BROWSER_NEW_TAB_URL
    return BROWSER_NEW_TAB_URL
  }, [browserNewTabBehavior, browserHomepage])

  // Browser proxy is configured globally in Cate's Browser settings. A stable
  // partition derived from the URL preserves that proxy profile's cookies.
  const activeProxy = browserProxyUrl.trim() || undefined
  const partition = partitionFor(activeProxy)
  // Key readiness to the partition so changing the setting blocks the new
  // webview synchronously, before an effect can configure its first request.
  const [readyPartition, setReadyPartition] = useState<string | null>(
    activeProxy ? null : partition,
  )
  const proxyReady = !activeProxy || readyPartition === partition

  // Each tab keeps its guest renderer for the lifetime of the tab. Destroying an
  // inactive guest would turn every tab switch into a page reload and discard
  // in-page state such as scroll position, form input, and media playback.
  const webviewSrcByTabRef = useRef(new Map(
    seedTabs.current.tabs.map((tab) => [tab.id, webviewSeedUrl(tab.url)]),
  ))
  const seededPartitionRef = useRef(partition)
  if (seededPartitionRef.current !== partition) {
    for (const tab of tabs) webviewSrcByTabRef.current.set(tab.id, webviewSeedUrl(tab.url))
    seededPartitionRef.current = partition
  }
  const webviewsByTabRef = useRef(new Map<string, WebviewElement>())
  const webviewRef = useRef<WebviewElement | null>(null)
  const [webviewEl, setWebviewEl] = useState<WebviewElement | null>(null)
  const [autofillPopup, setAutofillPopup] = useState<AutofillPopup | null>(null)
  const attachWebview = useCallback((tabId: string, element: WebviewElement | null) => {
    if (element) webviewsByTabRef.current.set(tabId, element)
    else webviewsByTabRef.current.delete(tabId)
    if (tabId !== activeTabIdRef.current) return
    webviewRef.current = element
    setWebviewEl(element)
  }, [])
  useEffect(() => {
    const element = webviewsByTabRef.current.get(activeTabId) ?? null
    webviewRef.current = element
    setWebviewEl(element)
    setAutofillPopup(null)
  }, [activeTabId])
  const urlInputRef = useRef<HTMLInputElement | null>(null)
  // Mirror isFocused into a ref so the long-lived browser-shortcut subscription
  // reads the current value without re-subscribing on every focus change.
  const isFocusedRef = useRef(isFocused)
  const [currentUrl, setCurrentUrl] = useState(initialUrl)
  // Latest URL, read by the partition-change effect to re-seed the remounted
  // webview without making it a dependency (which would remount on every nav).
  const currentUrlRef = useRef(initialUrl)
  const [inputUrl, setInputUrl] = useState(addressBarValue(initialUrl))
  // URL-bar autocomplete from global history.
  const [showSuggestions, setShowSuggestions] = useState(false)
  const [activeSuggestion, setActiveSuggestion] = useState(-1)
  const [canGoBack, setCanGoBack] = useState(false)
  const [canGoForward, setCanGoForward] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [browserZoomFactor, setBrowserZoomFactor] = useState(1)
  const browserZoomFactorRef = useRef(1)
  const [browserViewport, setBrowserViewport] = useState<BrowserViewport>({ preset: 'compact' })
  const [viewportContainerSize, setViewportContainerSize] = useState({ width: 0, height: 0 })
  const viewportContainerRef = useRef<HTMLDivElement | null>(null)
  const viewportDisplayScale = browserViewportScale(browserViewport, viewportContainerSize)
  // Distinct from loadError: the guest *renderer process* died (OOM / GPU
  // fault / native crash), not merely a failed navigation. Needs a reload to
  // respawn the renderer, so it gets its own overlay + recovery affordance.
  const [crashed, setCrashed] = useState(false)
  const [agentOverlayActive, setAgentOverlayActive] = useState(false)
  const [screenshot, setScreenshot] = useState<{ dataUrl: string; filePath: string } | null>(null)
  const screenshotTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // -------------------------------------------------------------------------
  // Navigation helpers
  // -------------------------------------------------------------------------

  const patchTab = useCallback((tabId: string, patch: Partial<BrowserTab>) => {
    setTabs((prev) => prev.map((tab) => (tab.id === tabId ? { ...tab, ...patch } : tab)))
  }, [])

  // Patch the active tab's fields (url/title) in the tabs array.
  const patchActiveTab = useCallback((patch: Partial<BrowserTab>) => {
    patchTab(activeTabIdRef.current, patch)
  }, [patchTab])

  // Navigate the active tab's own live guest. A start-page tab has no guest
  // until its first real navigation; its seed is recorded before React mounts
  // that guest so the first request already uses the correct session.
  const loadInView = useCallback((targetUrl: string) => {
    setLoadError(null)
    setCurrentUrl(targetUrl)
    setInputUrl(addressBarValue(targetUrl))
    currentUrlRef.current = targetUrl
    if (isStartPageUrl(targetUrl) || isBrowserInternalPage(targetUrl)) {
      if (isStartPageUrl(targetUrl)) {
        webviewSrcByTabRef.current.set(activeTabIdRef.current, 'about:blank')
      }
      setIsLoading(false)
      return
    }
    setIsLoading(true)
    const tabId = activeTabIdRef.current
    const webview = webviewsByTabRef.current.get(tabId)
    if (webview) webview.loadURL(targetUrl)
    else webviewSrcByTabRef.current.set(tabId, targetUrl)
  }, [])

  const navigateTo = useCallback((input: string) => {
    let targetUrl: string
    if (isStartPageUrl(input) || isBrowserInternalPage(input.trim())) {
      targetUrl = input.trim()
    } else if (isUrl(input)) {
      targetUrl = normalizeUrl(input)
    } else {
      // Use search engine
      const searchBase = SEARCH_ENGINE_URLS[browserSearchEngine] ?? SEARCH_ENGINE_URLS.google
      targetUrl = searchBase + encodeURIComponent(input)
    }
    patchActiveTab({ url: targetUrl })
    // Persist immediately so a quick app close / workspace switch before
    // did-navigate fires still restores to the URL the user typed.
    updateBrowserActiveTabUrl(workspaceId, panelId, targetUrl)
    loadInView(targetUrl)
  }, [browserSearchEngine, updateBrowserActiveTabUrl, workspaceId, panelId, patchActiveTab, loadInView])

  // --- Tab operations -------------------------------------------------------
  const selectTab = useCallback((id: string) => {
    if (id === activeTabIdRef.current) return
    const tab = tabs.find((t) => t.id === id)
    if (!tab) return
    activeTabIdRef.current = id
    setActiveTabId(id)
    const webview = webviewsByTabRef.current.get(id)
    const url = webview?.getURL() || tab.url
    setCurrentUrl(url)
    setInputUrl(addressBarValue(url))
    currentUrlRef.current = url
    setCanGoBack(webview?.canGoBack() ?? false)
    setCanGoForward(webview?.canGoForward() ?? false)
    setIsLoading(webview?.isLoading() ?? false)
    setLoadError(null)
    setCrashed(false)
  }, [tabs])

  // Open a tab at a specific URL and focus it. Split from addTab because addTab
  // is wired to a click handler (its argument is a MouseEvent, not a url).
  const openTab = useCallback((url?: string) => {
    const id = makeTabId()
    const u = url || newTabUrl()
    webviewSrcByTabRef.current.set(id, webviewSeedUrl(u))
    setTabs((prev) => [...prev, { id, url: u, title: browserInternalPageTitle(u) }])
    activeTabIdRef.current = id
    setActiveTabId(id)
    setCurrentUrl(u)
    setInputUrl(addressBarValue(u))
    currentUrlRef.current = u
    setCanGoBack(false)
    setCanGoForward(false)
    setIsLoading(!isStartPageUrl(u) && !isBrowserInternalPage(u))
    setLoadError(null)
    setCrashed(false)
    return id
  }, [newTabUrl])

  const addTab = useCallback(() => { openTab() }, [openTab])

  const closeTab = useCallback((id: string) => {
    const idx = tabs.findIndex((t) => t.id === id)
    if (idx === -1) return
    if (tabs.length === 1) {
      // Never leave a browser panel with zero tabs — reset the last one to a
      // fresh start page instead of closing the panel.
      const fresh: BrowserTab = { id: makeTabId(), url: BROWSER_NEW_TAB_URL, title: '' }
      webviewSrcByTabRef.current.delete(id)
      webviewsByTabRef.current.delete(id)
      webviewSrcByTabRef.current.set(fresh.id, webviewSeedUrl(fresh.url))
      setTabs([fresh])
      activeTabIdRef.current = fresh.id
      setActiveTabId(fresh.id)
      setCurrentUrl(BROWSER_NEW_TAB_URL)
      setInputUrl('')
      currentUrlRef.current = BROWSER_NEW_TAB_URL
      setCanGoBack(false)
      setCanGoForward(false)
      setIsLoading(false)
      return
    }
    webviewSrcByTabRef.current.delete(id)
    webviewsByTabRef.current.delete(id)
    const next = tabs.filter((t) => t.id !== id)
    setTabs(next)
    if (id === activeTabIdRef.current) {
      const neighbor = next[Math.min(idx, next.length - 1)]
      activeTabIdRef.current = neighbor.id
      setActiveTabId(neighbor.id)
      const webview = webviewsByTabRef.current.get(neighbor.id)
      const url = webview?.getURL() || neighbor.url
      setCurrentUrl(url)
      setInputUrl(addressBarValue(url))
      currentUrlRef.current = url
      setCanGoBack(webview?.canGoBack() ?? false)
      setCanGoForward(webview?.canGoForward() ?? false)
      setIsLoading(webview?.isLoading() ?? false)
    }
  }, [tabs])

  const togglePin = useCallback((id: string) => {
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, pinned: !t.pinned } : t)))
  }, [])

  // Persist the complete canonical navigation state.
  useEffect(() => {
    updatePanelTabs(workspaceId, panelId, tabs, activeTabId)
  }, [tabs, activeTabId, updatePanelTabs, workspaceId, panelId])

  const handleGoBack = useCallback(() => {
    webviewRef.current?.goBack()
  }, [])

  const handleGoForward = useCallback(() => {
    webviewRef.current?.goForward()
  }, [])

  const handleReload = useCallback(() => {
    webviewRef.current?.reload()
  }, [])

  const applyBrowserZoom = useCallback((factor: number) => {
    browserZoomFactorRef.current = factor
    setBrowserZoomFactor(factor)
  }, [])

  const adjustBrowserZoom = useCallback((direction: -1 | 1) => {
    const current = browserZoomFactorRef.current
    const next = direction > 0
      ? BROWSER_ZOOM_FACTORS.find((factor) => factor > current)
      : [...BROWSER_ZOOM_FACTORS].reverse().find((factor) => factor < current)
    if (next !== undefined) applyBrowserZoom(next)
  }, [applyBrowserZoom])

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
      writeCateFileDrag(e.dataTransfer, [screenshot.filePath])
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

  // Suggestions shown beneath the URL bar (history matches for the current input).
  const suggestions = useMemo(
    () => (showSuggestions ? querySuggestions(inputUrl, 8) : []),
    [showSuggestions, inputUrl, querySuggestions],
  )

  // Bookmark state for the current page (the star toggle). Not bookmarkable on
  // the start page or about: pages.
  const isBookmarked = bookmarks.some((b) => b.url === currentUrl)
  const canBookmark =
    !isStartPageUrl(currentUrl)
    && !isBrowserInternalPage(currentUrl)
    && !currentUrl.startsWith('about:')

  // Chrome-like chrome: tabs, address bar and overflow menu.
  const [menuOpen, setMenuOpen] = useState(false)
  const menuButtonRef = useRef<HTMLButtonElement>(null)
  const toggleBrowserMenu = useCallback(() => {
    setMenuOpen((open) => !open)
  }, [])

  // "New tab" → a new browser panel on the canvas (opens the start page).
  const handleNewTab = addTab

  const handleUrlBarKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveSuggestion((i) => Math.min(i + 1, suggestions.length - 1))
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveSuggestion((i) => Math.max(i - 1, -1))
      return
    }
    if (e.key === 'Escape') {
      setShowSuggestions(false)
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      const pick = activeSuggestion >= 0 ? suggestions[activeSuggestion]?.url : undefined
      setShowSuggestions(false)
      navigateTo(pick ?? inputUrl)
    }
  }, [inputUrl, navigateTo, suggestions, activeSuggestion])

  const submitAddressBar = useCallback(() => {
    const value = inputUrl.trim()
    if (value) navigateTo(value)
  }, [inputUrl, navigateTo])

  useEffect(() => {
    if (!isStartPageUrl(currentUrl)) return
    requestAnimationFrame(() => urlInputRef.current?.focus())
  }, [currentUrl])

  // -------------------------------------------------------------------------
  // Browser proxy
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
      setReadyPartition(partition)
      return
    }
    let cancelled = false
    setReadyPartition(null)
    window.electronAPI
      .browserSetProxy(partition, activeProxy)
      .then(() => { if (!cancelled) setReadyPartition(partition) })
      .catch((err) => {
        console.error('[BrowserPanel] Failed to configure proxy:', err)
        // Surface the failure but still let the page load (direct) rather than
        // leaving the panel permanently blank.
        if (!cancelled) {
          setLoadError('Failed to apply proxy settings')
          setReadyPartition(partition)
        }
      })
    return () => { cancelled = true }
  }, [partition, activeProxy])

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
    const webview = webviewEl
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
      currentUrlRef.current = url
      updateBrowserActiveTabUrl(workspaceId, panelId, url)
      patchTab(activeTabId, { url, title: webview.getTitle() || '' })
      recordVisit(url, webview.getTitle() || '')
    }

    const onDidNavigateInPage = (event: any) => {
      const url = event.url ?? webview.getURL()
      if (url === 'about:blank') return
      setCurrentUrl(url)
      setInputUrl(url)
      setCanGoBack(webview.canGoBack())
      setCanGoForward(webview.canGoForward())
      currentUrlRef.current = url
      updateBrowserActiveTabUrl(workspaceId, panelId, url)
      patchTab(activeTabId, { url })
    }

    const onPageFaviconUpdated = (event: any) => {
      // Electron fires an array of candidate favicon URLs; the first is the
      // page's preferred icon. Store it on the active tab (persisted with tabs).
      const favicon = Array.isArray(event.favicons) ? event.favicons[0] : undefined
      if (favicon) patchTab(activeTabId, { favicon })
    }

    const onPageTitleUpdated = (event: any) => {
      const title = event.title ?? webview.getTitle()
      if (title) {
        updatePanelTitle(workspaceId, panelId, title)
        patchTab(activeTabId, { title })
        // Capture the real title once the page sets it (dedups by URL in main).
        const navUrl = webview.getURL()
        if (navUrl && navUrl !== 'about:blank') recordVisit(navUrl, title)
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
      setAutofillPopup(null)
    }

    // The guest renderer process died.
    const onRenderProcessGone = (event: any) => {
      const reason = event?.reason ?? 'crashed'
      if (reason === 'clean-exit') return // normal teardown, not a crash
      console.error('[BrowserPanel] webview renderer gone:', reason)
      setCrashed(true)
      setIsLoading(false)
    }

    const onDidStopLoading = () => {
      setIsLoading(false)
    }

    const onIpcMessage = (event: any) => {
      if (event?.channel !== 'cate-browser-password-focus') return
      const payload = event.args?.[0] as Partial<AutofillPopup> | undefined
      if (
        !payload
        || typeof payload.targetId !== 'string'
        || !payload.rect
        || typeof payload.rect.left !== 'number'
        || typeof payload.rect.bottom !== 'number'
      ) return
      let webContentsId: number
      try { webContentsId = webview.getWebContentsId() } catch { return }
      void window.electronAPI.browserCredentialSuggestions(webContentsId).then((result) => {
        if (webviewRef.current !== webview || !result.suggestions?.length) {
          setAutofillPopup(null)
          return
        }
        setAutofillPopup({
          targetId: payload.targetId!,
          rect: payload.rect as AutofillPopup['rect'],
          suggestions: result.suggestions,
        })
      }).catch(() => setAutofillPopup(null))
    }
    webview.addEventListener('ipc-message', onIpcMessage)

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
      // Probe the live id first: registering an unattached element would hand
      // the driver a webview whose every call throws, which reads as a ready
      // panel that fails — worse than staying unregistered until it is real.
      let webContentsId: number
      try { webContentsId = webview.getWebContentsId() } catch { return }
      try { portalRegistry.register(panelId, webview as any) } catch { /* ignore */ }
      void window.electronAPI.browserControl({
        op: 'registerAgentBrowser',
        webContentsId,
        panelId,
        tabId: activeTabId,
      }).catch((error) => {
        console.error('[BrowserPanel] agent-browser registration failed:', error)
      })
    }
    webview.addEventListener('dom-ready', onDomReady)
    // dom-ready fires once per guest attach. If it already fired before this
    // effect re-ran (a re-render that keeps the same element), listening alone
    // would never register it — so probe the live id and register immediately.
    // getWebContentsId() throws while the guest is unattached, which is the
    // "wait for the event" case.
    onDomReady()

    webview.addEventListener('did-navigate', onDidNavigate)
    webview.addEventListener('did-navigate-in-page', onDidNavigateInPage)
    webview.addEventListener('page-favicon-updated', onPageFaviconUpdated)
    webview.addEventListener('page-title-updated', onPageTitleUpdated)
    webview.addEventListener('did-fail-load', onDidFailLoad)
    webview.addEventListener('did-start-loading', onDidStartLoading)
    webview.addEventListener('did-stop-loading', onDidStopLoading)
    webview.addEventListener('render-process-gone', onRenderProcessGone)

    return () => {
      try { portalRegistry.unregister(panelId) } catch { /* ignore */ }
      webview.removeEventListener('dom-ready', onDomReady)
      webview.removeEventListener('did-navigate', onDidNavigate)
      webview.removeEventListener('did-navigate-in-page', onDidNavigateInPage)
      webview.removeEventListener('page-favicon-updated', onPageFaviconUpdated)
      webview.removeEventListener('page-title-updated', onPageTitleUpdated)
      webview.removeEventListener('did-fail-load', onDidFailLoad)
      webview.removeEventListener('did-start-loading', onDidStartLoading)
      webview.removeEventListener('did-stop-loading', onDidStopLoading)
      webview.removeEventListener('render-process-gone', onRenderProcessGone)
      webview.removeEventListener('ipc-message', onIpcMessage)
    }
    // `webviewEl` is the dep that matters: it changes identity whenever the
    // element mounts, unmounts (start page) or remounts (proxy/partition
    // change), which is exactly when the listeners — and the portal
    // registration — must be rebound.
  }, [webviewEl, activeTabId, panelId, workspaceId, updatePanelTitle, updateBrowserActiveTabUrl, recordVisit, patchTab])

  const fillCredential = useCallback(async (credentialId: string) => {
    const popup = autofillPopup
    const webview = webviewRef.current
    setAutofillPopup(null)
    if (!popup || !webview) return
    let webContentsId: number
    try { webContentsId = webview.getWebContentsId() } catch { return }
    await window.electronAPI.browserCredentialFill({
      webContentsId,
      credentialId,
      targetId: popup.targetId,
    })
  }, [autofillPopup])

  // Expose this panel's control surface to the reverse API for its whole mounted
  // lifetime. Two things live here that the <webview> cannot answer:
  //   • navigate() — a panel on its start page has NO webview (the start page
  //     renders in its place), so `browser open` reaches it only through this.
  //   • tabs — the tab list and active live guest are panel-level state.
  // Registered once per panelId; the live values are read through refs so the
  // changing identity of the callbacks doesn't churn the registry.
  useEffect(() => {
    const element = viewportContainerRef.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const updateSize = (): void => {
      setViewportContainerSize({ width: element.clientWidth, height: element.clientHeight })
    }
    updateSize()
    const observer = new ResizeObserver(updateSize)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const controllerRef = useRef({
    navigateTo,
    tabs,
    activeTabId,
    openTab,
    selectTab,
    closeTab,
    setBrowserViewport,
  })
  controllerRef.current = {
    navigateTo,
    tabs,
    activeTabId,
    openTab,
    selectTab,
    closeTab,
    setBrowserViewport,
  }
  useEffect(() => {
    portalRegistry.registerController(panelId, {
      navigate: (url) => controllerRef.current.navigateTo(url),
      listTabs: () => controllerRef.current.tabs.map((tab) => ({
        id: tab.id,
        url: isStartPageUrl(tab.url) ? '' : tab.url,
        title: tab.title ?? '',
        active: tab.id === controllerRef.current.activeTabId,
      })),
      newTab: (url) => controllerRef.current.openTab(url),
      selectTab: (tabId) => {
        if (!controllerRef.current.tabs.some((tab) => tab.id === tabId)) return false
        controllerRef.current.selectTab(tabId)
        return true
      },
      closeTab: (tabId) => {
        if (!controllerRef.current.tabs.some((tab) => tab.id === tabId)) return false
        controllerRef.current.closeTab(tabId)
        return true
      },
      setViewport: (viewport) => controllerRef.current.setBrowserViewport(viewport),
    })
    return () => portalRegistry.unregisterController(panelId)
  }, [panelId])

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <div
      className="flex w-full h-full relative"
      onKeyDown={(event) => {
        releaseAgentCursor(panelId)
        handleChromeKeyDown(event)
      }}
      onPointerDownCapture={() => releaseAgentCursor(panelId)}
    >
      {/* Main column: browser chrome + content */}
      <div className="flex flex-col flex-1 min-w-0 h-full">
      {/* Tabs stay visible even when the browser has only one tab. */}
      <BrowserTabStrip
        tabs={tabs}
        activeTabId={activeTabId}
        onSelect={selectTab}
        onClose={closeTab}
        onNewTab={addTab}
        onTogglePin={togglePin}
      />

      {/* URL bar */}
      <div
        className="flex h-10 shrink-0 items-center gap-2 border-b border-subtle bg-surface-1 px-2"
        data-browser-toolbar
      >
        {/* Navigation controls — flat ghost buttons */}
        <div className="flex shrink-0 items-center gap-1">
          <Tooltip label="Back">
            <button
              onClick={handleGoBack}
              disabled={!canGoBack}
              className="w-7 h-7 flex items-center justify-center rounded-[10px] hover:bg-hover disabled:opacity-30 disabled:hover:bg-transparent text-secondary hover:text-primary transition-colors"
              aria-label="Back"
            >
              <ArrowLeft size={14} />
            </button>
          </Tooltip>
          <Tooltip label="Forward">
            <button
              onClick={handleGoForward}
              disabled={!canGoForward}
              className="w-7 h-7 flex items-center justify-center rounded-[10px] hover:bg-hover disabled:opacity-30 disabled:hover:bg-transparent text-secondary hover:text-primary transition-colors"
              aria-label="Forward"
            >
              <ArrowRight size={14} />
            </button>
          </Tooltip>
          <Tooltip label="Reload">
            <button
              onClick={handleReload}
              disabled={isStartPageUrl(currentUrl)}
              className="flex h-7 w-7 items-center justify-center rounded-[10px] text-secondary transition-colors hover:bg-hover hover:text-primary disabled:opacity-30 disabled:hover:bg-transparent"
              aria-label="Reload"
            >
              <ArrowClockwise size={14} className={isLoading ? 'animate-spin' : ''} />
            </button>
          </Tooltip>
        </div>

        {/* URL input + autocomplete */}
        <div className="flex-1 relative">
          <div
            className={`flex h-7 items-center gap-2 rounded-[10px] border px-3 transition-colors ${
              isStartPageUrl(currentUrl)
                ? 'border-strong bg-surface-1 focus-within:border-strong'
                : 'border-transparent bg-transparent hover:bg-surface-2 focus-within:border-strong focus-within:bg-surface-1'
            }`}
          >
            <input
              ref={urlInputRef}
              type="text"
              value={inputUrl}
              onChange={(e) => { setInputUrl(e.target.value); setShowSuggestions(true); setActiveSuggestion(-1) }}
              onFocus={() => setShowSuggestions(true)}
              onBlur={() => setTimeout(() => setShowSuggestions(false), 120)}
              onKeyDown={handleUrlBarKeyDown}
              className={`h-full min-w-0 flex-1 bg-transparent text-sm text-primary outline-none placeholder:text-muted ${
                isStartPageUrl(currentUrl) ? 'text-left' : 'text-center'
              }`}
              placeholder="Enter a URL"
            />
            {isStartPageUrl(currentUrl) && (
              <button
                type="button"
                onClick={submitAddressBar}
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
            onPick={(pickedUrl) => { setShowSuggestions(false); navigateTo(pickedUrl) }}
            onHover={setActiveSuggestion}
          />
        </div>

        {!isStartPageUrl(currentUrl) && (
          <>
            {/* Bookmark / favorite toggle */}
            <Tooltip label={isBookmarked ? 'Remove bookmark' : 'Bookmark this page'}>
              <button
                onClick={() => canBookmark && toggleBookmark(currentUrl, webviewRef.current?.getTitle() || currentUrl)}
                disabled={!canBookmark}
                className={`w-7 h-7 flex items-center justify-center rounded-[10px] transition-colors disabled:opacity-30 ${
                  isBookmarked
                    ? 'text-agent hover:bg-hover'
                    : 'text-secondary hover:text-primary hover:bg-hover'
                }`}
                aria-label={isBookmarked ? 'Remove bookmark' : 'Bookmark this page'}
              >
                <Star size={13} weight={isBookmarked ? 'fill' : 'regular'} />
              </button>
            </Tooltip>

            {/* Screenshot tool */}
            <Tooltip label="Screenshot">
              <button
                onClick={handleScreenshot}
                className="w-7 h-7 flex items-center justify-center rounded-[10px] hover:bg-hover text-secondary hover:text-primary transition-colors"
                aria-label="Screenshot"
              >
                <Camera size={13} />
              </button>
            </Tooltip>
          </>
        )}

        {/* Overflow menu (new tab, bookmarks, settings) */}
        <Tooltip label="Menu">
          <button
            ref={menuButtonRef}
            onClick={toggleBrowserMenu}
            className="w-7 h-7 flex items-center justify-center rounded-[10px] hover:bg-hover text-secondary hover:text-primary transition-colors"
            aria-label="Browser menu"
            aria-expanded={menuOpen}
          >
            <DotsThreeVertical size={15} />
          </button>
        </Tooltip>
      </div>

      {/* Overflow menu */}
      {menuOpen && (
        <BrowserMenu
          onNewTab={handleNewTab}
          onNavigate={navigateTo}
          onOpenPasswordManager={() => openTab(BROWSER_PASSWORD_MANAGER_URL)}
          zoomPercent={Math.round(browserZoomFactor * 100)}
          onZoomOut={() => adjustBrowserZoom(-1)}
          onZoomIn={() => adjustBrowserZoom(1)}
          onZoomReset={() => applyBrowserZoom(1)}
          onClose={() => setMenuOpen(false)}
          triggerRef={menuButtonRef}
        />
      )}

      {/* Webview + overlays container */}
      <div
        ref={viewportContainerRef}
        className="flex flex-1 items-start justify-start overflow-hidden relative"
      >
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

        {/* Keep every tab's native guest alive so switching tabs preserves the
            document, navigation history, scroll position, and form state. */}
        {proxyReady && tabs.map((tab) => (
          isBrowserInternalPage(tab.url) ? null : (
            <BrowserWebviewSlot
              panelId={panelId}
              key={`${panelId}:${partition}:${tab.id}`}
              tabId={tab.id}
              src={isStartPageUrl(tab.url)
                ? 'about:blank'
                : (webviewSrcByTabRef.current.get(tab.id) ?? tab.url)}
              partition={partition}
              active={tab.id === activeTabId}
              hidden={Boolean(
                loadError
                || crashed
                || isStartPageUrl(tab.url)
                || autofillPopup
                || menuOpen
                || showSuggestions
                || screenshot
                || agentOverlayActive
              )}
              viewport={browserViewport}
              displayScale={viewportDisplayScale}
              browserZoomFactor={browserZoomFactor}
              canvasBacked={canvasBacked}
              focused={isFocused}
              onElement={attachWebview}
            />
          )
        ))}

        {/* The start page visually replaces the active tab's about:blank guest.
            Keeping that guest mounted mirrors Codex's hidden bootstrap host:
            automation has a live target before the user navigates anywhere. */}
        {isStartPageUrl(currentUrl) && (
          <div className="absolute inset-0">
            <StartPage />
          </div>
        )}
        {isBrowserInternalPage(currentUrl) && <BrowserPasswordManagerPage />}

        {/* Host-rendered password suggestions. Only usernames cross renderer
            IPC; the selected password is decrypted and filled in main. */}
        {autofillPopup && (
          <div
            className="absolute z-40 min-w-56 max-w-[calc(100%-1rem)] overflow-hidden rounded-lg border border-subtle bg-surface-2 shadow-2xl"
            style={{
              left: Math.max(
                8,
                autofillPopup.rect.left * browserZoomFactor * viewportDisplayScale,
              ),
              top: Math.max(
                8,
                autofillPopup.rect.bottom * browserZoomFactor * viewportDisplayScale + 6,
              ),
            }}
          >
            <div className="flex items-center gap-2 border-b border-subtle px-3 py-2 text-xs text-muted">
              <Key size={13} />
              Saved passwords
            </div>
            {autofillPopup.suggestions.map((suggestion) => (
              <button
                key={suggestion.id}
                className="flex w-full flex-col px-3 py-2 text-left hover:bg-hover"
                onMouseDown={(event) => {
                  event.preventDefault()
                  void fillCredential(suggestion.id)
                }}
              >
                <span className="max-w-72 truncate text-sm text-primary">
                  {suggestion.username || 'Saved password'}
                </span>
                <span className="max-w-72 truncate text-[11px] text-muted">{suggestion.origin}</span>
              </button>
            ))}
          </div>
        )}

        {/* Agent activity — ghost pointer, target highlight and action label for
            `cate.browser.*` input, which is otherwise indistinguishable from the
            user's own. Sits above the webview and never takes pointer events. */}
        <AgentCursorOverlay
          panelId={panelId}
          scale={browserZoomFactor * viewportDisplayScale}
          onVisibilityChange={setAgentOverlayActive}
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
