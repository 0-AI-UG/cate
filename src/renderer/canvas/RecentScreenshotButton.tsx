import { useEffect, useState } from 'react'
import type { RecentScreenshot } from '../../shared/recentScreenshot'
import { CanvasToolbarButton } from './CanvasToolbarButton'

export function RecentScreenshotButton({ tooltipPlacement }: { tooltipPlacement: 'top' | 'right' }) {
  const [screenshot, setScreenshot] = useState<RecentScreenshot | null>(null)

  useEffect(() => {
    let mounted = true
    let receivedChange = false
    const unsubscribe = window.electronAPI.onRecentScreenshotChanged(value => {
      receivedChange = true
      setScreenshot(value)
    })
    void window.electronAPI.getRecentScreenshot().then(value => {
      if (mounted && !receivedChange) setScreenshot(value)
    }).catch(() => { /* Screenshot monitoring is optional. */ })
    return () => { mounted = false; unsubscribe() }
  }, [])

  useEffect(() => {
    if (!screenshot) return
    const timeout = setTimeout(() => setScreenshot(null), Math.max(0, screenshot.expiresAt - Date.now()))
    return () => clearTimeout(timeout)
  }, [screenshot])

  if (!screenshot) return null
  return (
    <CanvasToolbarButton
      label="Drag recent screenshot"
      tooltipPlacement={tooltipPlacement}
      draggable
      onDragStart={event => {
        event.preventDefault()
        void window.electronAPI.dragRecentScreenshot(screenshot.id).catch(() => {
          // Keep the shortcut available if the native drag could not start.
        })
      }}
    >
      <img src={screenshot.dataUrl} alt="Recent screenshot" draggable={false}
        className="h-8 w-8 rounded-full object-cover ring-1 ring-white/20 cursor-grab" />
    </CanvasToolbarButton>
  )
}
