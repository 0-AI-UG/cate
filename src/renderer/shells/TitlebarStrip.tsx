// =============================================================================
// TitlebarStrip — themed drag region rendered at the top of the main window.
//
// macOS (titleBarStyle: 'hiddenInset'): reserves space for the native traffic
// lights and provides a themed drag region. The native bar can't be tinted to a
// theme color, only dark/light, so we always use hidden-inset + this strip.
//
// Windows/Linux (frame: false): the window is fully frameless, so this strip is
// the entire title bar — a themed drag region with our custom WindowControls
// (minimize/maximize/close) on the right and double-click-to-maximize.
//
// In native fullscreen the OS hides its chrome, so the strip would otherwise be
// a dead zone at the top — subscribe to fullscreen state and collapse while it's
// active (on every platform).
// =============================================================================

import { useEffect, useState } from 'react'
import WindowControls from './WindowControls'

const IS_MAC = navigator.userAgent.includes('Mac')

export default function TitlebarStrip() {
  const [isFullscreen, setIsFullscreen] = useState<boolean>(
    () => window.electronAPI.isMainWindowFullscreen?.() ?? false,
  )

  useEffect(() => {
    return window.electronAPI.onFullscreenChange?.((value) => setIsFullscreen(value))
  }, [])

  if (isFullscreen) return null

  // macOS: empty strip, padded for the native traffic lights.
  if (IS_MAC) {
    return (
      <div
        className="titlebar-drag shrink-0 bg-titlebar-bg select-none"
        style={{ paddingLeft: 80, height: 28 }}
      />
    )
  }

  // Windows/Linux: full title bar with custom controls on the right.
  return (
    <div
      className="titlebar-drag shrink-0 bg-titlebar-bg select-none flex items-stretch justify-end"
      style={{ height: 28 }}
      onDoubleClick={() => window.electronAPI.windowToggleMaximize?.()}
    >
      <WindowControls />
    </div>
  )
}
