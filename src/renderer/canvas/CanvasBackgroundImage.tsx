// =============================================================================
// CanvasBackgroundImage — optional wallpaper drawn behind the grid and panels.
//
// The image is fixed to the viewport (cover/centred, like a desktop wallpaper)
// rather than panning with the world, so it reads as a backdrop and stays cheap
// (no per-pan repaint). The bytes are loaded once as a data URL via main —
// file:// would be blocked by the renderer CSP and the file usually lives
// outside the workspace's allowed fs roots.
//
// Readability: region titles render in the world layer directly over this
// backdrop, relying on --text-primary + a text shadow. To keep them legible
// over an arbitrary photo we (1) let the layer's opacity blend it toward the
// solid themed canvas background — which dims it on dark themes and lightens it
// on light themes for free — and (2) lay a theme-tuned scrim on top as a
// contrast floor regardless of the chosen opacity.
// =============================================================================

import React, { useEffect, useState } from 'react'
import { useSettingsStore } from '../stores/settingsStore'
import { getActiveTheme, subscribeTheme } from '../lib/themeManager'

const READABILITY = {
  dark: { filter: 'brightness(0.6) saturate(0.9)', scrim: 'rgba(0, 0, 0, 0.35)' },
  light: { filter: 'brightness(1.05) saturate(0.95)', scrim: 'rgba(255, 255, 255, 0.4)' },
} as const

const CanvasBackgroundImage: React.FC = () => {
  const path = useSettingsStore((s) => s.canvasBackgroundImagePath)
  const opacity = useSettingsStore((s) => s.canvasBackgroundImageOpacity)
  const [dataUrl, setDataUrl] = useState<string | null>(null)
  const [themeType, setThemeType] = useState<'dark' | 'light'>(() => getActiveTheme().type)

  // Track light/dark so the dim/brighten treatment follows theme changes live.
  useEffect(() => subscribeTheme((t) => setThemeType(t.type)), [])

  // Load (or clear) the wallpaper whenever the configured path changes.
  useEffect(() => {
    if (!path) {
      setDataUrl(null)
      return
    }
    let cancelled = false
    void window.electronAPI
      .readCanvasBackgroundImage(path)
      .then((url) => {
        if (!cancelled) setDataUrl(url)
      })
      .catch(() => {
        if (!cancelled) setDataUrl(null)
      })
    return () => {
      cancelled = true
    }
  }, [path])

  if (!dataUrl) return null

  const treatment = READABILITY[themeType]
  const clampedOpacity = Math.max(0, Math.min(1, opacity))

  return (
    <div
      aria-hidden
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 0,
        pointerEvents: 'none',
        overflow: 'hidden',
      }}
    >
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
      <div
        style={{
          position: 'absolute',
          inset: 0,
          backgroundColor: treatment.scrim,
        }}
      />
    </div>
  )
}

export default React.memo(CanvasBackgroundImage)
