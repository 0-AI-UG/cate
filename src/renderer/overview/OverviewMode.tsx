// =============================================================================
// OverviewMode — full-screen overlay showing every workspace's windows as
// schematic cards in a zoom/pan-able space. Mirrors the CommandPalette overlay
// pattern (conditional-rendered from App.tsx on uiStore.showOverview).
// =============================================================================

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { X } from '@phosphor-icons/react'
import { useUIStore } from '../stores/uiStore'
import { collectOverview, type OverviewWorkspace } from './collectOverview'
import WorkspaceBox from './WorkspaceBox'

const ZOOM_MIN = 0.1
const ZOOM_MAX = 2
const FIT_PADDING = 64

interface View {
  scale: number
  offset: { x: number; y: number }
}

const OverviewMode: React.FC = () => {
  const setShowOverview = useUIStore((s) => s.setShowOverview)
  const close = useCallback(() => setShowOverview(false), [setShowOverview])

  // Collect in an effect, not during render: collectOverview() flushes the
  // active canvas into appStore (a store mutation), which must not run in the
  // render phase.
  const [data, setData] = useState<OverviewWorkspace[]>([])
  useEffect(() => {
    setData(collectOverview())
  }, [])

  const overlayRef = useRef<HTMLDivElement>(null)
  const worldRef = useRef<HTMLDivElement>(null)
  const [view, setView] = useState<View>({ scale: 1, offset: { x: 0, y: 0 } })
  const fittedRef = useRef(false)

  // Fit-to-screen once the content has been laid out.
  useLayoutEffect(() => {
    if (fittedRef.current || data.length === 0 || !worldRef.current) return
    const w = worldRef.current.offsetWidth
    const h = worldRef.current.offsetHeight
    if (w === 0 || h === 0) return
    const vw = window.innerWidth
    const vh = window.innerHeight
    const scale = Math.min((vw - FIT_PADDING * 2) / w, (vh - FIT_PADDING * 2) / h, 1)
    const safeScale = Math.max(scale, ZOOM_MIN)
    setView({
      scale: safeScale,
      offset: { x: (vw - w * safeScale) / 2, y: Math.max(FIT_PADDING, (vh - h * safeScale) / 2) },
    })
    fittedRef.current = true
  }, [data])

  // Esc closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        close()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [close])

  // Cmd/Ctrl + wheel = zoom around cursor; plain wheel / two-finger = pan.
  // Attached as a native non-passive listener so preventDefault() actually
  // suppresses the browser's pinch-zoom / scroll (React's onWheel is passive).
  useEffect(() => {
    const el = overlayRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      if (e.metaKey || e.ctrlKey) {
        const factor = Math.exp(-e.deltaY * 0.01)
        setView((prev) => {
          const next = Math.min(Math.max(prev.scale * factor, ZOOM_MIN), ZOOM_MAX)
          const cx = e.clientX
          const cy = e.clientY
          const contentX = (cx - prev.offset.x) / prev.scale
          const contentY = (cy - prev.offset.y) / prev.scale
          return { scale: next, offset: { x: cx - contentX * next, y: cy - contentY * next } }
        })
      } else {
        setView((prev) => ({ scale: prev.scale, offset: { x: prev.offset.x - e.deltaX, y: prev.offset.y - e.deltaY } }))
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  const boxes = useMemo(
    () => data.map((ws) => <WorkspaceBox key={ws.id} workspace={ws} />),
    [data],
  )

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 overflow-hidden backdrop-blur-sm"
      style={{ backgroundColor: 'color-mix(in srgb, var(--canvas-bg) 95%, transparent)' }}
    >
      {/* Header */}
      <div className="absolute top-0 inset-x-0 z-10 flex items-center justify-between px-4 py-3 pointer-events-none">
        <span className="text-sm font-semibold text-secondary pointer-events-auto">Übersicht</span>
        <button
          type="button"
          onClick={close}
          title="Schließen (Esc)"
          className="flex items-center justify-center w-8 h-8 rounded text-muted hover:text-primary hover:bg-hover transition-colors pointer-events-auto"
        >
          <X size={16} />
        </button>
      </div>

      {/* Zoom/pan world */}
      <div
        ref={worldRef}
        className="absolute top-0 left-0 flex flex-col gap-8 p-8"
        style={{
          transform: `translate(${view.offset.x}px, ${view.offset.y}px) scale(${view.scale})`,
          transformOrigin: '0 0',
        }}
      >
        {boxes}
      </div>
    </div>
  )
}

export default OverviewMode
