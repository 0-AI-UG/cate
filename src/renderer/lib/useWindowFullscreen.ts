// Subscribes to *this* window's native-fullscreen state. Main pushes each
// window its own state (see windowFactory `sendFullscreen`), so this reflects
// whether the current window is fullscreen — not whether any window is. Used to
// collapse the macOS window-control chrome (the traffic-light island / dock
// tab-bar dot reservation) when the window enters native fullscreen.
import { useEffect, useState } from 'react'

export function useWindowFullscreen(): boolean {
  const [isFullscreen, setIsFullscreen] = useState<boolean>(
    () => window.electronAPI.isMainWindowFullscreen?.() ?? false,
  )

  useEffect(() => {
    return window.electronAPI.onFullscreenChange?.((value) => setIsFullscreen(value))
  }, [])

  return isFullscreen
}
