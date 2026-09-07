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

import { useCallback, useEffect, useRef, useState } from 'react'
import { AppWindow } from 'lucide-react'
import { useAppStore } from '../../stores/appStore'
import { KNOWN_NATIVE_APPS } from '../../lib/nativeApps'
import { macKeyCode } from './keycodes'
import type { NativeAppInputEvent } from '../../../shared/types'
import type { NativeAppPanelProps } from '../types'

const CAPTURE_FPS = 30
// Throttle interval for pointer-move forwarding (ms) — ~120/s is smooth
// without flooding the socket.
const MOVE_THROTTLE_MS = 8
// Debounce for panel-resize → window-resize commands (ms).
const RESIZE_DEBOUNCE_MS = 100

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

// The image's placement within the canvas (fractions of canvas size), updated
// on every draw so pointer coordinates can be mapped past any letterbox bands.
interface ImageRect { left: number; top: number; width: number; height: number }

function NativeAppCapture({ bundleId }: { bundleId: string }) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const imageRectRef = useRef<ImageRect>({ left: 0, top: 0, width: 1, height: 1 })
  const [sessionId, setSessionId] = useState<string | null>(null)
  const sessionIdRef = useRef<string | null>(null)
  const [status, setStatus] = useState<CaptureStatus>({ phase: 'launching' })
  const [hasFrame, setHasFrame] = useState(false)
  const lastMoveRef = useRef(0)

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
          imageRectRef.current = drawLetterboxed(canvas, bitmap)
          if (typeof bitmap.close === 'function') bitmap.close()
          setHasFrame(true)
        })
        .catch(() => { /* dropped frame — the next one will draw */ })
    })
  }, [sessionId])

  // Keep a ref of the session id for the DOM event handlers (which are wired
  // once and read the latest id without re-binding on every change).
  useEffect(() => {
    sessionIdRef.current = sessionId
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

  // Send an input event to the captured app for the current session.
  const sendInput = useCallback((event: NativeAppInputEvent): void => {
    const sid = sessionIdRef.current
    if (sid) window.electronAPI.nativeAppInput(sid, event)
  }, [])

  // Map a client-space pointer position to normalized (0…1) coords over the
  // captured window content, accounting for any letterbox bands.
  const normPoint = useCallback((clientX: number, clientY: number): { nx: number; ny: number } => {
    const canvas = canvasRef.current
    if (!canvas) return { nx: 0, ny: 0 }
    const rect = canvas.getBoundingClientRect()
    const fracX = rect.width > 0 ? (clientX - rect.left) / rect.width : 0
    const fracY = rect.height > 0 ? (clientY - rect.top) / rect.height : 0
    const img = imageRectRef.current
    const nx = img.width > 0 ? (fracX - img.left) / img.width : fracX
    const ny = img.height > 0 ? (fracY - img.top) / img.height : fracY
    return { nx: clamp01(nx), ny: clamp01(ny) }
  }, [])

  // Wire pointer + keyboard + wheel forwarding directly on the canvas so we can
  // control passive/preventDefault (React's synthetic wheel is passive). Drag
  // tracking uses window listeners so a drag that leaves the panel still moves.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const mods = (e: MouseEvent | KeyboardEvent) => ({ cmd: e.metaKey, shift: e.shiftKey, opt: e.altKey, ctrl: e.ctrlKey })
    const button = (e: MouseEvent): 0 | 1 => (e.button === 2 ? 1 : 0)

    const onWindowMove = (e: MouseEvent): void => {
      const now = performance.now()
      if (now - lastMoveRef.current < MOVE_THROTTLE_MS) return
      lastMoveRef.current = now
      const { nx, ny } = normPoint(e.clientX, e.clientY)
      sendInput({ k: 'm', a: 'move', nx, ny })
    }
    const onWindowUp = (e: MouseEvent): void => {
      const { nx, ny } = normPoint(e.clientX, e.clientY)
      sendInput({ k: 'm', a: 'up', nx, ny, b: button(e) })
      window.removeEventListener('mousemove', onWindowMove)
      window.removeEventListener('mouseup', onWindowUp)
    }
    const onMouseDown = (e: MouseEvent): void => {
      e.preventDefault()
      e.stopPropagation() // don't let the canvas start a node-drag / pan
      canvas.focus()
      const { nx, ny } = normPoint(e.clientX, e.clientY)
      sendInput({ k: 'm', a: 'down', nx, ny, b: button(e), clicks: e.detail || 1, ...mods(e) })
      window.addEventListener('mousemove', onWindowMove)
      window.addEventListener('mouseup', onWindowUp)
    }
    const onHoverMove = (e: MouseEvent): void => {
      const now = performance.now()
      if (now - lastMoveRef.current < MOVE_THROTTLE_MS) return
      lastMoveRef.current = now
      const { nx, ny } = normPoint(e.clientX, e.clientY)
      sendInput({ k: 'm', a: 'move', nx, ny })
    }
    const onContextMenu = (e: MouseEvent): void => { e.preventDefault() }
    const onWheel = (e: WheelEvent): void => {
      // Cmd/Ctrl+scroll stays with the canvas (zoom); plain scroll goes to app.
      if (e.metaKey || e.ctrlKey) return
      e.preventDefault()
      e.stopPropagation()
      const { nx, ny } = normPoint(e.clientX, e.clientY)
      sendInput({ k: 's', nx, ny, dx: Math.round(-e.deltaX), dy: Math.round(-e.deltaY) })
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      e.preventDefault(); e.stopPropagation()
      const code = macKeyCode(e.code)
      if (code !== undefined) sendInput({ k: 'k', a: 'down', code, ...mods(e) })
      else if (e.key.length === 1) sendInput({ k: 'k', a: 'down', text: e.key, ...mods(e) })
    }
    const onKeyUp = (e: KeyboardEvent): void => {
      e.preventDefault(); e.stopPropagation()
      const code = macKeyCode(e.code)
      if (code !== undefined) sendInput({ k: 'k', a: 'up', code, ...mods(e) })
    }

    canvas.addEventListener('mousedown', onMouseDown)
    canvas.addEventListener('mousemove', onHoverMove)
    canvas.addEventListener('contextmenu', onContextMenu)
    canvas.addEventListener('wheel', onWheel, { passive: false })
    canvas.addEventListener('keydown', onKeyDown)
    canvas.addEventListener('keyup', onKeyUp)
    return () => {
      canvas.removeEventListener('mousedown', onMouseDown)
      canvas.removeEventListener('mousemove', onHoverMove)
      canvas.removeEventListener('contextmenu', onContextMenu)
      canvas.removeEventListener('wheel', onWheel)
      canvas.removeEventListener('keydown', onKeyDown)
      canvas.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('mousemove', onWindowMove)
      window.removeEventListener('mouseup', onWindowUp)
    }
  }, [normPoint, sendInput])

  // Drive the captured app window to the panel's logical size (debounced), so
  // it reflows to fill the panel — no letterbox, native resolution. Fires on
  // mount and whenever the panel resizes.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    let timer: ReturnType<typeof setTimeout> | null = null
    const push = (): void => {
      const sid = sessionIdRef.current
      const w = container.clientWidth
      const h = container.clientHeight
      if (sid && w > 0 && h > 0) window.electronAPI.nativeAppResize(sid, w, h)
    }
    const schedule = (): void => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(push, RESIZE_DEBOUNCE_MS)
    }
    // Initial push once a session exists (the observer also fires on observe).
    schedule()
    if (typeof ResizeObserver === 'undefined') {
      return () => { if (timer) clearTimeout(timer) }
    }
    const observer = new ResizeObserver(schedule)
    observer.observe(container)
    return () => {
      if (timer) clearTimeout(timer)
      observer.disconnect()
    }
  }, [sessionId])

  const overlayText =
    status.phase === 'error' ? `Capture error — ${status.message}` : !hasFrame ? 'Launching…' : null

  return (
    <div ref={containerRef} className="relative w-full h-full bg-black">
      <canvas
        ref={canvasRef}
        tabIndex={0}
        className="w-full h-full block outline-none cursor-default"
      />
      {overlayText && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/60 text-xs text-secondary pointer-events-none px-4 text-center">
          {overlayText}
        </div>
      )}
    </div>
  )
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

// -----------------------------------------------------------------------------
// Frame drawing — letterbox the source bitmap into the canvas's current CSS
// size (device-pixel-scaled) so aspect ratio is preserved regardless of the
// panel's shape. Returns the image's placement (fractions of the canvas) so
// pointer coordinates can be mapped past the letterbox bands.
// -----------------------------------------------------------------------------

function drawLetterboxed(canvas: HTMLCanvasElement, bitmap: ImageBitmap): ImageRect {
  const ctx = canvas.getContext('2d')
  if (!ctx) return { left: 0, top: 0, width: 1, height: 1 }
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
  return {
    left: dx / canvas.width,
    top: dy / canvas.height,
    width: drawWidth / canvas.width,
    height: drawHeight / canvas.height,
  }
}
