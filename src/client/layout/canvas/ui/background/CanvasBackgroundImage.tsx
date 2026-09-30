// The optional wallpaper behind the grid and panels. It is fixed to the
// viewport (cover, centred) rather than panning with the world, so it reads as
// a backdrop and never repaints on pan.
//
// Region titles render straight over it, so for legibility the layer's opacity
// blends it toward the themed canvas background (dimming on dark themes,
// lightening on light ones) and the theme's backdrop scrim sits on top as a
// contrast floor.

import React, { useEffect, useState } from 'react'
import { getActiveTheme, subscribeTheme } from '@kernel/ui'
import { canvasBackgroundPort } from '../../background'
import { useCanvasSetting } from '../../settings'
import { getBuiltinWallpaper } from './builtinWallpapers'

const READABILITY = {
  dark: { filter: 'brightness(0.6) saturate(0.9)' },
  light: { filter: 'brightness(1.05) saturate(0.95)' },
} as const

function CanvasBackgroundImage() {
  const path = useCanvasSetting('canvasBackgroundImagePath')
  const opacity = useCanvasSetting('canvasBackgroundImageOpacity')
  const [dataUrl, setDataUrl] = useState<string | null>(null)
  const [themeType, setThemeType] = useState<'dark' | 'light'>(() => getActiveTheme().type)

  useEffect(() => subscribeTheme((t) => setThemeType(t.type)), [])

  useEffect(() => {
    if (!path) {
      setDataUrl(null)
      return
    }
    const builtin = getBuiltinWallpaper(path)
    if (builtin) {
      setDataUrl(builtin.url)
      return
    }
    const port = canvasBackgroundPort()
    if (!port) {
      setDataUrl(null)
      return
    }
    let cancelled = false
    port.readImage(path).then(
      (url) => { if (!cancelled) setDataUrl(url) },
      () => { if (!cancelled) setDataUrl(null) },
    )
    return () => { cancelled = true }
  }, [path])

  if (!dataUrl) return null

  const treatment = READABILITY[themeType]
  const clampedOpacity = Math.max(0, Math.min(1, opacity))

  return (
    <div aria-hidden style={{ position: 'absolute', inset: 0, zIndex: 0, pointerEvents: 'none', overflow: 'hidden' }}>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          backgroundImage: `url("${dataUrl}")`,
          backgroundSize: 'cover',
          backgroundPosition: 'center',
          backgroundRepeat: 'no-repeat',
          filter: treatment.filter,
          opacity: clampedOpacity,
        }}
      />
      <div style={{ position: 'absolute', inset: 0, backgroundColor: 'var(--canvas-backdrop-scrim)' }} />
    </div>
  )
}

export default React.memo(CanvasBackgroundImage)
