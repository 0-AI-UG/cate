// =============================================================================
// MacWindowChrome — macOS-only floating window-control island.
//
// Replaces the old full-width TitlebarStrip on macOS. Instead of a distinct
// header bar above the app, this is a small transparent island pinned to the
// top-left corner that (a) reserves horizontal space for the native traffic
// lights and (b) provides the window drag region over that strip. All other
// UI — sidebar, dock tabs, canvas — fills the window from y=0, so there is no
// dead header above the canvas.
//
// The left-sidebar toggle no longer lives here: the left rail carries its own
// collapse toggle (inset below the lights), and a floating reopen toggle in
// MainWindowShell handles the fully-hidden state — mirroring the right rail.
//
// In native fullscreen the OS hides the traffic lights and the window can't be
// dragged, so the island has nothing to reserve and nothing to drag: it renders
// nothing, and the left rail reclaims the corner from y=0 (see Sidebar's
// macChromeInset).
//
// Non-macOS keeps the frameless TitlebarStrip (menu bar + custom controls).
// =============================================================================

import { IS_MAC } from '../lib/platform'
import { useWindowFullscreen } from '../lib/useWindowFullscreen'

// Matches the dock tab bar's min-height (36px) and the sidebar's opaque top
// strip, so the traffic lights and dock tabs center on the same line and the
// sidebar's content insets to exactly clear the chrome.
export const MAC_CHROME_HEIGHT = 36
// Horizontal space reserved for the native traffic lights.
export const TRAFFIC_LIGHTS_WIDTH = 78
// Width the dock tab bar reserves at the top-left (so its first tab clears the
// island) when the left sidebar is fully hidden — lights + floating reopen
// toggle in windowed mode, just the toggle in fullscreen.
export const MAC_CHROME_WIDTH = 108

export default function MacWindowChrome(): React.ReactElement | null {
  const isFullscreen = useWindowFullscreen()

  // Native chrome (menu bar + custom controls via TitlebarStrip) off macOS.
  if (!IS_MAC) return null

  // No lights to clear and no window to drag in fullscreen — rendering the strip
  // anyway would put a drag region over the left rail's collapse toggle, which
  // sits in this corner once the inset collapses.
  if (isFullscreen) return null

  // Empty draggable strip over the traffic-light area so the window can be moved
  // by dragging the top-left corner. The sidebar toggle now lives in the rail.
  return (
    <div
      className="absolute top-0 left-0 z-40 select-none"
      style={{
        height: MAC_CHROME_HEIGHT,
        width: TRAFFIC_LIGHTS_WIDTH,
        WebkitAppRegion: 'drag',
      } as React.CSSProperties}
    />
  )
}
