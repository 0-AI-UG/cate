// =============================================================================
// TitlebarStrip — themed drag region rendered at the top of the main window on
// macOS (titleBarStyle: 'hiddenInset'). Reserves space for the traffic lights
// and gives the window a drag region matched to the app theme. macOS always
// uses the hidden-inset title bar — the native bar can't be tinted to a theme
// color, only dark/light.
//
// In native macOS fullscreen the traffic lights are hidden by the OS, so the
// strip would otherwise show as a 28px dead zone at the top — subscribe to
// fullscreen state and collapse while fullscreen is active.
// =============================================================================

import { useEffect, useState } from 'react'

const IS_MAC = navigator.userAgent.includes('Mac')

export default function TitlebarStrip() {
  const [isFullscreen, setIsFullscreen] = useState<boolean>(
    () => window.electronAPI.isMainWindowFullscreen?.() ?? false,
  )

  useEffect(() => {
    if (!IS_MAC) return
    return window.electronAPI.onFullscreenChange?.((value) => setIsFullscreen(value))
  }, [])

  if (!IS_MAC || isFullscreen) return null

  return (
    <div
      className="titlebar-drag shrink-0 bg-titlebar-bg select-none"
      style={{ paddingLeft: 80, height: 28 }}
    />
  )
}
