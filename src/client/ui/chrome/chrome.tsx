// Window chrome pieces client/ui draws: the reopen-sidebar button and the
// header of application overlays. The space window controls take (macOS
// traffic lights) comes from the desktop port; other shells report none.

import { useSyncExternalStore, type CSSProperties, type ReactNode } from 'react'
import { PanelLeft } from 'lucide-react'
import { Tooltip } from '@kernel/ui'
import { desktopPort, subscribeDesktopPort } from '../desktop'
import { useUIStore } from '../state/uiStore'

const REOPEN_BUTTON_WIDTH = 40

function subscribeInset(listener: () => void): () => void {
  let off = desktopPort()?.onWindowControlsInsetChange(listener) ?? (() => {})
  const offPort = subscribeDesktopPort(() => {
    off()
    off = desktopPort()?.onWindowControlsInsetChange(listener) ?? (() => {})
    listener()
  })
  return () => { off(); offPort() }
}

/** Width the window controls take at the top left, in px. */
export function useWindowControlsInset(): number {
  return useSyncExternalStore(subscribeInset, () => desktopPort()?.windowControlsInset() ?? 0)
}

/** Space content at the top left leaves while the sidebar is hidden (window
 *  controls plus the reopen button). */
export function useLeftChromeInset(): number {
  const hidden = useUIStore((s) => s.sidebarHidden)
  const controls = useWindowControlsInset()
  return hidden ? controls + REOPEN_BUTTON_WIDTH : 0
}

export function LeftSidebarReopen(): JSX.Element | null {
  const hidden = useUIStore((s) => s.sidebarHidden)
  const controls = useWindowControlsInset()
  if (!hidden) return null
  return (
    <div
      className="absolute top-0 left-0 z-40 flex items-center select-none"
      style={{ height: 44, paddingLeft: controls || 8, WebkitAppRegion: 'no-drag' } as CSSProperties}
    >
      <Tooltip action="toggleSidebar" label="Show sidebar" placement="bottom">
        <button
          type="button"
          aria-label="Show sidebar"
          onClick={() => useUIStore.getState().setSidebarHidden(false)}
          className="flex items-center justify-center w-7 h-7 rounded-[10px] text-muted hover:text-primary hover:bg-hover transition-colors"
        >
          <PanelLeft size={16} />
        </button>
      </Tooltip>
    </div>
  )
}

/** Title chrome of an application overlay; navigation belongs in its content. */
export function OverlayHeader({ title, children }: { title: string; children?: ReactNode }): JSX.Element {
  const inset = useLeftChromeInset()
  return (
    <header
      className="relative z-10 flex h-11 shrink-0 items-center gap-2 bg-canvas-bg px-6 text-primary after:pointer-events-none after:absolute after:inset-x-0 after:top-full after:h-6 after:bg-gradient-to-b after:from-canvas-bg after:to-transparent"
      style={{ paddingLeft: Math.max(24, inset) }}
    >
      <h1 className="min-w-0 flex-1 truncate text-[13px] font-medium">{title}</h1>
      {children && <div className="flex shrink-0 items-center gap-2">{children}</div>}
    </header>
  )
}
