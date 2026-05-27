import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { NATIVE_APP_PRESETS } from '../../shared/nativeAppPresets'
import type { NativeAppBindingStatus, NativeAppConfig, NativeAppWindowInfo } from '../../shared/types'
import { useAppStore } from '../stores/appStore'
import { useCanvasStoreApi } from '../stores/CanvasStoreContext'
import type { PanelProps } from './types'

function isConfigured(config: NativeAppConfig | undefined): boolean {
  return !!(config?.presetId || config?.exePath || config?.windowTitlePattern)
}

function labelForConfig(config: NativeAppConfig | undefined): string {
  if (!config) return 'Native App'
  const preset = NATIVE_APP_PRESETS.find((candidate) => candidate.id === config.presetId)
  return preset?.label ?? config.windowTitlePattern ?? config.exePath?.split(/[\\/]/).pop() ?? 'Native App'
}

function statusText(status: NativeAppBindingStatus | null, connecting: boolean): string {
  if (connecting) return 'Connecting...'
  if (!status) return 'Not connected'
  if (status.error) return status.error
  if (!status.alive) return 'App window closed'
  return status.visible ? 'Synced' : 'Hidden while canvas moves'
}

export default function NativeAppPanel({ panelId, workspaceId }: PanelProps) {
  const contentRef = useRef<HTMLDivElement | null>(null)
  const syncFrame = useRef<number>(0)
  const autoBound = useRef(false)
  const canvasStoreApi = useCanvasStoreApi()

  const panel = useAppStore((state) => state.workspaces.find((ws) => ws.id === workspaceId)?.panels[panelId])
  const updatePanelTitle = useAppStore((state) => state.updatePanelTitle)
  const updatePanelNativeApp = useAppStore((state) => state.updatePanelNativeApp)

  const [status, setStatus] = useState<NativeAppBindingStatus | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [windows, setWindows] = useState<NativeAppWindowInfo[]>([])
  const [showAttachPicker, setShowAttachPicker] = useState(false)
  const [customPath, setCustomPath] = useState('')

  const config = panel?.nativeApp
  const title = useMemo(() => labelForConfig(config), [config])
  const isWindows = navigator.userAgent.includes('Windows')

  const syncBounds = useCallback(() => {
    if (syncFrame.current) cancelAnimationFrame(syncFrame.current)
    syncFrame.current = requestAnimationFrame(() => {
      syncFrame.current = 0
      const el = contentRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      if (rect.width <= 1 || rect.height <= 1) return
      // Native top-level windows include resize shadows/borders that can bleed
      // outside the DOM rect. Slightly shrink height to avoid bottom overflow.
      const bottomInset = 8
      window.electronAPI.nativeAppSetBounds(panelId, {
        x: window.screenX + rect.left,
        y: window.screenY + rect.top,
        width: rect.width,
        height: Math.max(1, rect.height - bottomInset),
      }).catch(() => undefined)
    })
  }, [panelId])

  const bindConfig = useCallback(async (nextConfig: NativeAppConfig, hwnd?: string, attachFirst = false) => {
    setConnecting(true)
    setStatus(null)
    try {
      const request = { panelId, config: nextConfig, hwnd }
      let nextStatus = attachFirst
        ? await window.electronAPI.nativeAppBind(request)
        : null
      if (!nextStatus?.alive && nextConfig.bindingMode === 'launch') {
        nextStatus = await window.electronAPI.nativeAppLaunch(request)
      } else if (!nextStatus) {
        nextStatus = await window.electronAPI.nativeAppBind(request)
      }
      const finalStatus = nextStatus
      setStatus(finalStatus)
      if (finalStatus.alive && finalStatus.title) {
        updatePanelTitle(workspaceId, panelId, finalStatus.title)
        syncBounds()
      }
    } finally {
      setConnecting(false)
    }
  }, [panelId, syncBounds, updatePanelTitle, workspaceId])

  const bindUserChoice = useCallback(async (nextConfig: NativeAppConfig, hwnd?: string) => {
    setConnecting(true)
    setStatus(null)
    try {
      const request = { panelId, config: nextConfig, hwnd }
      const nextStatus = nextConfig.bindingMode === 'launch'
        ? await window.electronAPI.nativeAppLaunch(request)
        : await window.electronAPI.nativeAppBind(request)
      setStatus(nextStatus)
      if (nextStatus.alive && nextStatus.title) {
        updatePanelTitle(workspaceId, panelId, nextStatus.title)
        syncBounds()
      }
    } finally {
      setConnecting(false)
    }
  }, [panelId, syncBounds, updatePanelTitle, workspaceId])

  const persistAndBind = useCallback((nextConfig: NativeAppConfig, hwnd?: string, nextTitle?: string) => {
    const title = nextTitle ?? labelForConfig(nextConfig)
    updatePanelNativeApp(workspaceId, panelId, nextConfig, title)
    if (panel) {
      window.electronAPI.panelWindowSyncMeta?.({
        panel: { ...panel, nativeApp: nextConfig, title },
        workspaceId,
      }).catch(() => undefined)
    }
    void bindUserChoice(nextConfig, hwnd)
  }, [bindUserChoice, panel, panelId, updatePanelNativeApp, workspaceId])

  const openAttachPicker = useCallback(async () => {
    const result = await window.electronAPI.nativeAppListWindows()
    setWindows(result)
    setShowAttachPicker(true)
  }, [])

  const chooseExe = useCallback(async () => {
    const filePath = await window.electronAPI.openFileDialog({
      title: 'Choose Windows app',
      filters: [{ name: 'Applications', extensions: ['exe'] }],
    })
    if (!filePath) return
    setCustomPath(filePath)
    const titleHint = filePath.split(/[\\/]/).pop()?.replace(/\.exe$/i, '') || 'Native App'
    persistAndBind({
      bindingMode: 'launch',
      exePath: filePath,
      windowTitlePattern: titleHint,
    }, undefined, titleHint)
  }, [persistAndBind])

  const launchPreset = useCallback((presetId: string) => {
    const preset = NATIVE_APP_PRESETS.find((candidate) => candidate.id === presetId)
    if (!preset) return
    persistAndBind({
      bindingMode: 'launch',
      presetId,
      windowTitlePattern: preset.titlePattern,
      launchArgs: preset.launchArgs,
    }, undefined, preset.label)
  }, [persistAndBind])

  const attachWindow = useCallback((win: NativeAppWindowInfo) => {
    const nextConfig: NativeAppConfig = {
      bindingMode: 'attach',
      windowTitlePattern: win.title,
      exePath: win.exePath,
    }
    setShowAttachPicker(false)
    persistAndBind(nextConfig, win.hwnd, win.title)
  }, [persistAndBind])

  useEffect(() => {
    if (autoBound.current || !isConfigured(config)) return
    autoBound.current = true
    void bindConfig(config!, undefined, true)
  }, [bindConfig, config])

  useEffect(() => {
    return () => {
      if (syncFrame.current) cancelAnimationFrame(syncFrame.current)
      window.electronAPI.nativeAppUnbind(panelId).catch(() => undefined)
    }
  }, [panelId])

  useEffect(() => {
    const el = contentRef.current
    if (!el) return
    const observer = new ResizeObserver(syncBounds)
    observer.observe(el)
    window.addEventListener('resize', syncBounds)
    window.addEventListener('scroll', syncBounds, true)
    syncBounds()
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', syncBounds)
      window.removeEventListener('scroll', syncBounds, true)
    }
  }, [syncBounds])

  useEffect(() => {
    // CSS transform changes (canvas pan/zoom) do not trigger ResizeObserver,
    // so explicitly resync the overlay whenever viewport transform changes.
    const unsubscribe = canvasStoreApi.subscribe((state, prev) => {
      if (
        state.zoomLevel !== prev.zoomLevel ||
        state.viewportOffset.x !== prev.viewportOffset.x ||
        state.viewportOffset.y !== prev.viewportOffset.y
      ) {
        syncBounds()
      }
    })
    return unsubscribe
  }, [canvasStoreApi, syncBounds])

  useEffect(() => {
    const applyGestureVisibility = () => {
      window.electronAPI.nativeAppSetVisible(panelId, true).catch(() => undefined)
      syncBounds()
    }
    const observer = new MutationObserver(applyGestureVisibility)
    observer.observe(document.body, { attributes: true, attributeFilter: ['class'] })
    applyGestureVisibility()
    return () => observer.disconnect()
  }, [panelId, syncBounds])

  useEffect(() => {
    const timer = setInterval(async () => {
      const next = await window.electronAPI.nativeAppGetBinding(panelId).catch(() => null)
      if (next) setStatus(next)
    }, 2000)
    return () => clearInterval(timer)
  }, [panelId])

  const connected = !!status?.alive && !status.error

  return (
    <div className="relative h-full w-full bg-[#0b0d12] text-foreground flex flex-col overflow-hidden" data-panel-content>
      <div className="flex items-center gap-2 border-b border-border/60 bg-card/80 px-3 py-2 text-xs">
        <div className={`h-2 w-2 rounded-full ${connected ? 'bg-emerald-400' : 'bg-amber-400'}`} />
        <div className="min-w-0 flex-1 truncate font-medium">{panel?.title ?? title}</div>
        <button className="rounded border border-border px-2 py-1 hover:bg-accent" onClick={openAttachPicker}>
          Attach
        </button>
        <button className="rounded border border-border px-2 py-1 hover:bg-accent" onClick={chooseExe}>
          Browse .exe
        </button>
        {connected && (
          <button
            className="rounded border border-border px-2 py-1 hover:bg-accent"
            onClick={() => {
              window.electronAPI.nativeAppUnbind(panelId).catch(() => undefined)
              setStatus(null)
            }}
          >
            Unlink
          </button>
        )}
      </div>

      <div ref={contentRef} className="relative flex-1 overflow-hidden bg-black/70">
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 p-6 text-center">
          <div>
            <div className="text-lg font-semibold">{connected ? status?.title ?? title : 'Native Windows App'}</div>
            <div className="mt-1 text-sm text-muted">{statusText(status, connecting)}</div>
          </div>

          {!isWindows && (
            <div className="max-w-md rounded border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-200">
              Native app panels are Windows-only in v1.
            </div>
          )}

          {!connected && (
            <div className="flex max-w-2xl flex-wrap items-center justify-center gap-2">
              {NATIVE_APP_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  className="rounded border border-border bg-card px-3 py-2 text-sm hover:bg-accent"
                  onClick={() => launchPreset(preset.id)}
                  disabled={connecting}
                >
                  Launch {preset.label}
                </button>
              ))}
            </div>
          )}

          {!connected && (
            <div className="flex w-full max-w-xl gap-2">
              <input
                className="min-w-0 flex-1 rounded border border-border bg-background px-3 py-2 text-sm outline-none"
                placeholder="C:\\Path\\To\\App.exe"
                value={customPath}
                onChange={(event) => setCustomPath(event.target.value)}
              />
              <button
                className="rounded border border-border bg-card px-3 py-2 text-sm hover:bg-accent disabled:opacity-50"
                disabled={!customPath.trim() || connecting}
                onClick={() => {
                  const titleHint = customPath.split(/[\\/]/).pop()?.replace(/\.exe$/i, '') || 'Native App'
                  persistAndBind({ bindingMode: 'launch', exePath: customPath, windowTitlePattern: titleHint }, undefined, titleHint)
                }}
              >
                Launch custom
              </button>
            </div>
          )}
        </div>
      </div>

      {showAttachPicker && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="max-h-[70%] w-full max-w-2xl overflow-hidden rounded-lg border border-border bg-card shadow-xl">
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <div className="font-medium">Attach Running Window</div>
              <button className="text-sm text-muted hover:text-foreground" onClick={() => setShowAttachPicker(false)}>Close</button>
            </div>
            <div className="max-h-96 overflow-auto p-2">
              {windows.length === 0 && <div className="p-4 text-sm text-muted">No attachable windows found.</div>}
              {windows.map((win) => (
                <button
                  key={win.hwnd}
                  className="flex w-full items-center justify-between gap-3 rounded px-3 py-2 text-left text-sm hover:bg-accent disabled:opacity-40"
                  disabled={win.isBound}
                  onClick={() => attachWindow(win)}
                >
                  <span className="min-w-0 flex-1 truncate">{win.title}</span>
                  <span className="shrink-0 text-xs text-muted">{win.isBound ? 'Bound' : `PID ${win.processId}`}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
