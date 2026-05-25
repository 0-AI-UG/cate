// =============================================================================
// TitlebarStrip — themed drag region rendered at the top of the main window
// when macOS native tabs are disabled (titleBarStyle: 'hiddenInset'). Reserves
// space for the traffic lights and gives the window a drag region matched to
// the app theme.
//
// Reads the boot-time nativeTabs value from the URL (set by main on window
// create) instead of the live setting, so the strip always matches the actual
// window chrome. Toggling the setting at runtime has no effect until restart.
//
// In native macOS fullscreen the traffic lights are hidden by the OS, so the
// strip would otherwise show as a 28px dead zone at the top — subscribe to
// fullscreen state and collapse while fullscreen is active.
// =============================================================================

import { useEffect, useState } from 'react'

const IS_MAC = navigator.userAgent.includes('Mac')
const NATIVE_TABS_BOOT = new URLSearchParams(window.location.search).get('nativeTabsBoot') === '1'

export default function TitlebarStrip() {
  const [isFullscreen, setIsFullscreen] = useState<boolean>(
    () => window.electronAPI.isMainWindowFullscreen?.() ?? false,
  )

  useEffect(() => {
    if (!IS_MAC || NATIVE_TABS_BOOT) return
    return window.electronAPI.onFullscreenChange?.((value) => setIsFullscreen(value))
  }, [])

  if (!IS_MAC || NATIVE_TABS_BOOT || isFullscreen) return null

  return (
    <div
      className="titlebar-drag shrink-0 bg-titlebar-bg select-none"
      style={{ paddingLeft: 80, height: 28 }}
    />
  )
}
