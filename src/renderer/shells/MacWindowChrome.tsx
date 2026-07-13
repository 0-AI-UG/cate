// =============================================================================
// MacWindowChrome — macOS-only floating window-control island.
//
// Replaces the old full-width TitlebarStrip on macOS. Instead of a distinct
// header bar above the app, this is a small transparent island pinned to the
// top-left corner that (a) reserves horizontal space for the native traffic
// lights, (b) provides the window drag region, and (c) hosts the left-sidebar
// toggle right of the lights. All other UI — sidebar, dock tabs, canvas — fills
// the window from y=0, so there is no dead header above the canvas.
//
// In native fullscreen the OS hides the traffic lights, so the dots reservation
// collapses and the toggle slides to the left edge — but the island (and the
// sidebar toggle) stays, so the sidebar can still be opened/closed there.
//
// Non-macOS keeps the frameless TitlebarStrip (menu bar + custom controls).
// =============================================================================

import { SidebarSimple } from '@phosphor-icons/react'
import { IS_MAC } from '../lib/platform'
import { useWindowFullscreen } from '../lib/useWindowFullscreen'
import { useUIStore } from '../stores/uiStore'
import { Tooltip } from '../ui/Tooltip'

// Matches the dock tab bar's min-height (36px) and the sidebar's opaque top
// strip, so the toggle, traffic lights, and dock tabs all center on the same
// line and the sidebar's content insets to exactly clear the chrome.
export const MAC_CHROME_HEIGHT = 36
// Horizontal space reserved for the native traffic lights; the toggle sits to
// their right. In fullscreen the lights are gone, so the toggle hugs the edge.
const TRAFFIC_LIGHTS_WIDTH = 78
const FULLSCREEN_LEFT_PAD = 8
// Width the dock tab bar reserves at the top-left (so its first tab clears the
// island) when the left sidebar is collapsed — full island (lights + toggle) in
// windowed mode, just the toggle in fullscreen.
export const MAC_CHROME_WIDTH = 108
export const MAC_CHROME_WIDTH_FS = 40

const NO_DRAG = { WebkitAppRegion: 'no-drag' } as React.CSSProperties

export default function MacWindowChrome(): React.ReactElement | null {
  const isFullscreen = useWindowFullscreen()
  const toggleSidebar = useUIStore((s) => s.toggleSidebar)

  // Native chrome (menu bar + custom controls via TitlebarStrip) off macOS.
  if (!IS_MAC) return null

  return (
    <div
      className="absolute top-0 left-0 z-40 flex items-center select-none"
      style={{
        height: MAC_CHROME_HEIGHT,
        paddingLeft: isFullscreen ? FULLSCREEN_LEFT_PAD : TRAFFIC_LIGHTS_WIDTH,
        WebkitAppRegion: 'drag',
      } as React.CSSProperties}
    >
      <Tooltip label="Toggle Sidebar">
        <button
          type="button"
          aria-label="Toggle sidebar"
          onClick={() => toggleSidebar()}
          style={NO_DRAG}
          className="flex items-center justify-center w-[22px] h-[22px] rounded text-secondary hover:text-primary hover:bg-hover transition-colors"
        >
          <SidebarSimple size={16} />
        </button>
      </Tooltip>
    </div>
  )
}
