import { useRef, useState, type ReactNode } from 'react'

const MIN_WIDTH = 180
const MAX_WIDTH = 480
const COLLAPSE_OVERSHOOT = 64

export function ExplorerSidebar({ visible, fill = false, onHide, children }: {
  visible: boolean
  fill?: boolean
  onHide: () => void
  children: ReactNode
}) {
  const sidebarRef = useRef<HTMLElement>(null)
  const [width, setWidth] = useState(260)
  const [dragging, setDragging] = useState(false)
  const drag = useRef<{ startX: number; startWidth: number; scale: number; max: number } | null>(null)

  return <aside
    ref={sidebarRef}
    aria-hidden={!visible}
    className={`relative shrink-0 h-full ${dragging ? '' : 'transition-[width,opacity] duration-200 ease-out motion-reduce:transition-none'}`}
    style={{ width: visible ? (fill ? '100%' : width) : 0, maxWidth: fill ? 'none' : '70%', opacity: visible ? 1 : 0 }}
  >
    <div className={`h-full overflow-hidden ${fill ? '' : 'border-l border-subtle'}`} style={{ visibility: visible ? 'visible' : 'hidden', transition: visible ? undefined : 'visibility 0s 200ms' }}>
      <div className="h-full" style={{ width: fill ? '100%' : width }}>{children}</div>
    </div>
    {visible && !fill && <div
      role="separator"
      aria-label="Resize file explorer"
      aria-orientation="vertical"
      aria-valuemin={MIN_WIDTH}
      aria-valuemax={MAX_WIDTH}
      aria-valuenow={Math.round(width)}
      tabIndex={0}
      className="absolute -left-1 top-0 bottom-0 w-2 z-40 cursor-col-resize touch-none select-none group hover:bg-focus/20"
      onKeyDown={(event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
        event.preventDefault()
        event.stopPropagation()
        setWidth((current) => Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, current + (event.key === 'ArrowLeft' ? 16 : -16))))
      }}
      onPointerDown={(event) => {
        if (event.button !== 0 || !sidebarRef.current) return
        event.preventDefault()
        event.stopPropagation()
        const sidebar = sidebarRef.current
        const parent = sidebar.parentElement!
        const scale = parent.getBoundingClientRect().width / parent.clientWidth || 1
        drag.current = { startX: event.clientX, startWidth: sidebar.getBoundingClientRect().width / scale, scale, max: Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, parent.clientWidth * 0.7)) }
        event.currentTarget.setPointerCapture(event.pointerId)
        setDragging(true)
      }}
      onPointerMove={(event) => {
        const current = drag.current
        if (!current) return
        event.stopPropagation()
        const requested = current.startWidth + (current.startX - event.clientX) / current.scale
        if (requested < MIN_WIDTH - COLLAPSE_OVERSHOOT) {
          drag.current = null
          setDragging(false)
          event.currentTarget.releasePointerCapture(event.pointerId)
          onHide()
          return
        }
        setWidth(Math.max(MIN_WIDTH, Math.min(current.max, requested)))
      }}
      onPointerUp={(event) => {
        if (!drag.current) return
        event.stopPropagation()
        drag.current = null
        setDragging(false)
        event.currentTarget.releasePointerCapture(event.pointerId)
      }}
      onLostPointerCapture={() => {
        drag.current = null
        setDragging(false)
      }}
    >
      <div className="absolute left-[3px] top-0 bottom-0 w-px group-hover:bg-focus" />
    </div>}
  </aside>
}
