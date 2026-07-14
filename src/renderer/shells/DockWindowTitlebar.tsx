// =============================================================================
// DockWindowTitlebar — macOS-only header bar for detached dock windows.
//
// Detached windows keep a conventional title bar (unlike the main window, which
// uses the floating MacWindowChrome island). This is a full-width themed strip
// pinned to the top: it (a) reserves horizontal space for the native traffic
// lights, (b) provides the window drag region, and (c) shows the active panel's
// title centered in the remaining space. The dock tab bar sits full-width just
// below it (DockWindowShell drops the tab bar's traffic-light indent on macOS).
//
// In native fullscreen the OS hides the traffic lights and there is no window to
// drag, so — like the old TitlebarStrip — this collapses to nothing and the tab
// bar fills from y=0.
//
// Non-macOS detached windows keep their frameless custom WindowControls overlay
// (DockWindowShell), so this renders nothing there.
// =============================================================================

import { IS_MAC } from '../lib/platform'
import { useWindowFullscreen } from '../lib/useWindowFullscreen'
import { useActivePanelStore } from '../lib/activePanel'
import { useAppStore } from '../stores/appStore'

// Matches the dock tab bar's min-height so the header + tabs read as one stack,
// and centers the native traffic lights (dock lights sit at y≈11, see
// windowFactory trafficLightPosition) on this row.
export const DOCK_TITLEBAR_HEIGHT = 36
// Horizontal space reserved on the left for the native traffic lights; the title
// centers in the space to their right.
const TRAFFIC_LIGHTS_WIDTH = 78

interface DockWindowTitlebarProps {
  workspaceId: string
}

export default function DockWindowTitlebar({
  workspaceId,
}: DockWindowTitlebarProps): React.ReactElement | null {
  const isFullscreen = useWindowFullscreen()
  const activePanelId = useActivePanelStore((s) => s.activePanelId)
  const panels = useAppStore((s) => s.workspaces.find((w) => w.id === workspaceId)?.panels)

  // Non-macOS keeps the frameless WindowControls overlay; native fullscreen hides
  // the lights and the window can't be dragged, so collapse (tabs fill from y=0).
  if (!IS_MAC) return null
  if (isFullscreen) return null

  // Prefer the active panel's title; fall back to the first panel, then a
  // neutral app name so the bar is never blank.
  const title =
    (activePanelId ? panels?.[activePanelId]?.title : undefined) ??
    (panels ? Object.values(panels)[0]?.title : undefined) ??
    'Cate'

  return (
    <div
      className="dock-window-titlebar shrink-0 bg-titlebar-bg select-none flex items-center justify-center"
      style={{
        height: DOCK_TITLEBAR_HEIGHT,
        paddingLeft: TRAFFIC_LIGHTS_WIDTH,
        WebkitAppRegion: 'drag',
      } as React.CSSProperties}
    >
      <span className="px-3 text-xs text-secondary truncate">{title}</span>
    </div>
  )
}
