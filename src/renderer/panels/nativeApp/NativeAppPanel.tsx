// =============================================================================
// NativeAppPanel — shows a real macOS app on the canvas as a live JPEG stream
// captured by the main-process NativeAppBroker + cate-nativehost sidecar.
//
// Two states, driven by whether the panel has a persisted `nativeAppBundleId`
// (PanelState field, survives remount/restart):
//   - no bundle id  -> NativeAppLauncher: pick a known app or type a bundle id.
//     Choosing one persists it via appStore.setPanelNativeAppBundleId.
//   - has bundle id -> NativeAppCapture: acquire a capture session, draw
//     incoming JPEG frames onto a <canvas> (letterboxed to preserve aspect),
//     release the session on unmount / bundle change.
//
// View-only for now — no input forwarding (that's the next milestone). Zoom/
// clip/occlude come for free from the enclosing CanvasNode; this component
// must not add its own zoom logic.
// =============================================================================

import { useEffect, useRef, useState } from 'react'
import { AppWindow } from '@phosphor-icons/react'
import { useAppStore } from '../../stores/appStore'
import { KNOWN_NATIVE_APPS } from '../../lib/nativeApps'
import type { NativeAppPanelProps } from '../types'

const CAPTURE_FPS = 12

// -----------------------------------------------------------------------------
// Component
// -----------------------------------------------------------------------------

export default function NativeAppPanel({ panelId, workspaceId, nativeAppBundleId }: NativeAppPanelProps) {
  if (!nativeAppBundleId) {
    return <NativeAppLauncher panelId={panelId} workspaceId={workspaceId} />
  }
  // Keyed by bundleId so picking a different app (a future "change app" affordance)
  // fully resets the capture component's session/canvas state.
  return <NativeAppCapture key={nativeAppBundleId} bundleId={nativeAppBundleId} />
}

// -----------------------------------------------------------------------------
// Launcher — no bundle id yet
// -----------------------------------------------------------------------------

function NativeAppLauncher({ panelId, workspaceId }: { panelId: string; workspaceId: string }) {
  const setPanelNativeAppBundleId = useAppStore((s) => s.setPanelNativeAppBundleId)
  const [customBundleId, setCustomBundleId] = useState('')

  const choose = (bundleId: string): void => {
    const trimmed = bundleId.trim()
    if (!trimmed) return
    setPanelNativeAppBundleId(workspaceId, panelId, trimmed)
  }

  return (
    <div className="flex flex-col items-center justify-center gap-4 w-full h-full bg-surface-4 text-secondary p-6">
      <AppWindow size={28} className="text-muted" />
      <p className="text-sm font-medium">Capture a native app</p>
      <div className="flex flex-wrap gap-2 justify-center max-w-sm">
        {KNOWN_NATIVE_APPS.map((app) => (
          <button
            key={app.bundleId}
            type="button"
            onClick={() => choose(app.bundleId)}
            className="px-3 py-1.5 text-xs rounded bg-surface-2 hover:bg-surface-1 text-secondary"
          >
            {app.label}
          </button>
        ))}
      </div>
      <form
        className="flex gap-2 items-center"
        onSubmit={(e) => {
          e.preventDefault()
          choose(customBundleId)
        }}
      >
        <input
          type="text"
          value={customBundleId}
          onChange={(e) => setCustomBundleId(e.target.value)}
          placeholder="com.example.App"
          spellCheck={false}
          className="px-2 py-1 text-xs rounded bg-surface-2 text-primary border border-subtle w-56 focus:outline-none focus:ring-1 focus:ring-focus-blue"
        />
        <button
          type="submit"
          disabled={!customBundleId.trim()}
          className="px-3 py-1.5 text-xs rounded bg-surface-2 hover:bg-surface-1 text-secondary disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Launch
        </button>
      </form>
    </div>
  )
}

// -----------------------------------------------------------------------------
// Capture — has a bundle id: acquire a session and stream frames
// -----------------------------------------------------------------------------

type CaptureStatus = { phase: 'launching' } | { phase: 'live' } | { phase: 'error'; message: string }

function NativeAppCapture({ bundleId }: { bundleId: string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [status, setStatus] = useState<CaptureStatus>({ phase: 'launching' })
  const [hasFrame, setHasFrame] = useState(false)

  // Acquire on mount, release on unmount (and whenever `bundleId` changes —
  // though in practice a bundle change remounts this whole component via the
  // `key` in NativeAppPanel above).
  //
  // React StrictMode double-invokes this effect (mount -> cleanup -> mount) in
  // dev. That's safe here: the first mount's acquire() call may still resolve
  // after its cleanup has already fired (`cancelled` is set), in which case we
  // release that stray session immediately instead of leaking it. Only the
  // second mount's session is ever adopted into state.
  useEffect(() => {
    let cancelled = false
    let acquiredSessionId: string | null = null
    setStatus({ phase: 'launching' })
    setHasFrame(false)
    setSessionId(null)

    window.electronAPI
      .nativeAppAcquire({ bundleId, fps: CAPTURE_FPS })
      .then((res) => {
        if ('error' in res) {
          if (!cancelled) setStatus({ phase: 'error', message: res.error })
          return
        }
        acquiredSessionId = res.sessionId
        if (cancelled) {
          void window.electronAPI.nativeAppRelease(res.sessionId).catch(() => { /* already gone */ })
          return
        }
        setSessionId(res.sessionId)
      })
      .catch((err) => {
        if (!cancelled) setStatus({ phase: 'error', message: err instanceof Error ? err.message : String(err) })
      })

    return () => {
      cancelled = true
      if (acquiredSessionId) {
        void window.electronAPI.nativeAppRelease(acquiredSessionId).catch(() => { /* already gone */ })
      }
    }
  }, [bundleId])

  // Draw incoming frames for this session onto the canvas.
  useEffect(() => {
    if (!sessionId) return
    return window.electronAPI.onNativeAppFrame((payload) => {
      if (payload.sessionId !== sessionId) return
      const canvas = canvasRef.current
      if (!canvas) return
      // payload.jpeg's Uint8Array can be backed by ArrayBufferLike (Node/Electron
      // IPC typings), which Blob's stricter BlobPart type doesn't accept — copy
      // into a fresh ArrayBuffer-backed view first.
      createImageBitmap(new Blob([new Uint8Array(payload.jpeg)], { type: 'image/jpeg' }))
        .then((bitmap) => {
          drawLetterboxed(canvas, bitmap)
          if (typeof bitmap.close === 'function') bitmap.close()
          setHasFrame(true)
        })
        .catch(() => { /* dropped frame — the next one will draw */ })
    })
  }, [sessionId])

  // Surface ready/error control messages as a small overlay.
  useEffect(() => {
    if (!sessionId) return
    return window.electronAPI.onNativeAppStatus(({ sessionId: sid, control }) => {
      if (sid !== sessionId) return
      if (control.t === 'error') {
        const message = typeof control.message === 'string' ? control.message : String(control.message)
        setStatus({ phase: 'error', message })
      }
    })
  }, [sessionId])

  const overlayText =
    status.phase === 'error' ? `Capture error — ${status.message}` : !hasFrame ? 'Launching…' : null

  return (
    <div className="relative w-full h-full bg-black">
      <canvas ref={canvasRef} className="w-full h-full block" />
      {overlayText && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/60 text-xs text-secondary pointer-events-none px-4 text-center">
          {overlayText}
        </div>
      )}
    </div>
  )
}

// -----------------------------------------------------------------------------
// Frame drawing — letterbox the source bitmap into the canvas's current CSS
// size (device-pixel-scaled) so aspect ratio is preserved regardless of the
// panel's shape.
// -----------------------------------------------------------------------------

function drawLetterboxed(canvas: HTMLCanvasElement, bitmap: ImageBitmap): void {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const dpr = window.devicePixelRatio || 1
  const pixelWidth = Math.max(1, Math.round((canvas.clientWidth || bitmap.width) * dpr))
  const pixelHeight = Math.max(1, Math.round((canvas.clientHeight || bitmap.height) * dpr))
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth
    canvas.height = pixelHeight
  }
  const scale = Math.min(canvas.width / bitmap.width, canvas.height / bitmap.height)
  const drawWidth = bitmap.width * scale
  const drawHeight = bitmap.height * scale
  const dx = (canvas.width - drawWidth) / 2
  const dy = (canvas.height - drawHeight) / 2
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(bitmap, dx, dy, drawWidth, drawHeight)
}
