import { useEffect, useState } from 'react'
import { X } from '@phosphor-icons/react'
import type { RecentScreenshot } from '../../shared/recentScreenshot'
import { Tooltip } from '../ui/Tooltip'

export function RecentScreenshotButton({ expandDown = false }: { expandDown?: boolean }) {
  const [screenshots, setScreenshots] = useState<RecentScreenshot[]>([])
  const [dismissed, setDismissed] = useState<string[]>([])
  const [expanded, setExpanded] = useState(false)
  const [hoveredId, setHoveredId] = useState<string | null>(null)

  useEffect(() => {
    // Renderer hot reload can run against an older preload bridge until restart.
    const api = window.electronAPI
    if (typeof api?.onRecentScreenshotChanged !== 'function'
      || typeof api.getRecentScreenshot !== 'function'
      || typeof api.dragRecentScreenshot !== 'function') return

    const receive = (value: RecentScreenshot[] | RecentScreenshot | null) => {
      const recent = Array.isArray(value) ? value : value ? [value] : []
      setScreenshots(recent)
      setDismissed(ids => ids.filter(id => recent.some(screenshot => screenshot.id === id)))
    }
    let mounted = true
    let receivedChange = false
    const unsubscribe = window.electronAPI.onRecentScreenshotChanged(value => {
      receivedChange = true
      receive(value)
    })
    void window.electronAPI.getRecentScreenshot().then(value => {
      if (mounted && !receivedChange) receive(value)
    }).catch(() => { /* Screenshot monitoring is optional. */ })
    return () => { mounted = false; unsubscribe() }
  }, [])

  const visible = screenshots.filter(screenshot => !dismissed.includes(screenshot.id))
  if (!visible.length) return null
  return (
    <div
      className="relative w-10 transition-[height] duration-200 ease-out motion-reduce:transition-none"
      style={{ height: expanded ? 40 + (visible.length - 1) * 52 : 40 }}
      onMouseEnter={() => setExpanded(true)}
      onMouseLeave={() => setExpanded(false)}
      onFocus={() => setExpanded(true)}
      onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setExpanded(false) }}
    >
      {visible.map((screenshot, index) => (
        <div key={screenshot.id} className="group absolute h-10 w-10 transition-[transform,top,bottom] duration-200 ease-out motion-reduce:transition-none"
          onMouseEnter={() => setHoveredId(screenshot.id)}
          onMouseLeave={() => setHoveredId(null)}
          style={{
            [expandDown ? 'top' : 'bottom']: expanded ? index * 52 : index * 5,
            zIndex: visible.length - index,
            transform: `rotate(${hoveredId === screenshot.id ? 8 : 3}deg) scale(${hoveredId === screenshot.id ? 1.05 : expanded ? 1 : 1 - index * 0.04})`,
          }}
        >
          <Tooltip label="Drag screenshot to a panel" placement="left">
            <button
              type="button"
              aria-label="Drag screenshot to a panel"
              className="block h-10 w-10 cursor-grab overflow-hidden rounded-lg border-0 bg-transparent p-0 ring-1 ring-[var(--border-strong)] transition-[transform,filter] duration-200 ease-out group-hover:brightness-110 active:scale-95 active:cursor-grabbing motion-reduce:transition-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
              draggable
              onDragStart={event => {
                event.preventDefault()
                void window.electronAPI.dragRecentScreenshot(screenshot.id).catch(() => {
                  // Keep the shortcut available if the native drag could not start.
                })
              }}
            >
              <img src={screenshot.dataUrl} alt="Recent screenshot" draggable={false}
                className="h-full w-full object-cover" />
            </button>
          </Tooltip>
          <button
            type="button"
            aria-label="Dismiss screenshot preview"
            onClick={() => setDismissed(ids => [...ids, screenshot.id])}
            className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-surface-2 text-secondary opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100 hover:text-primary focus-visible:outline focus-visible:outline-2 motion-reduce:transition-none"
          >
            <X size={10} weight="bold" />
          </button>
        </div>
      ))}
    </div>
  )
}
