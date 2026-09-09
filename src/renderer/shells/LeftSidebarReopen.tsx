import { PanelLeft } from 'lucide-react'
import { useUIStore } from '../stores/uiStore'
import { IS_MAC } from '../lib/platform'
import { useWindowFullscreen } from '../lib/useWindowFullscreen'
import { MAC_CHROME_WIDTH, TRAFFIC_LIGHTS_WIDTH } from './MacWindowChrome'
import { Tooltip } from '../ui/Tooltip'

export function useLeftChromeInset(): number {
  const hidden = useUIStore((s) => s.leftSidebarHidden)
  const fullscreen = useWindowFullscreen()
  return hidden ? (IS_MAC && !fullscreen ? MAC_CHROME_WIDTH : 40) : 0
}

export function LeftSidebarReopen() {
  const hidden = useUIStore((s) => s.leftSidebarHidden)
  const fullscreen = useWindowFullscreen()
  if (!hidden) return null
  return (
    <div
      className="absolute top-0 left-0 z-40 flex items-center select-none"
      style={{ height: 44, paddingLeft: IS_MAC && !fullscreen ? TRAFFIC_LIGHTS_WIDTH : 8, WebkitAppRegion: 'no-drag' } as React.CSSProperties}
    >
      <Tooltip action="toggleSidebar" label="Show sidebar" placement="bottom">
        <button
          type="button"
          aria-label="Show sidebar"
          onClick={() => useUIStore.getState().setLeftSidebarHidden(false)}
          className="flex items-center justify-center w-7 h-7 rounded-[10px] text-muted hover:text-primary hover:bg-hover transition-colors"
        >
          <PanelLeft size={16} />
        </button>
      </Tooltip>
    </div>
  )
}
