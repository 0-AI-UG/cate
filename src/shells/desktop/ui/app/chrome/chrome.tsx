// Window chrome pieces ui/app draws: the reopen-sidebar button and the
// header of application overlays. The space window controls take (macOS
// traffic lights) comes from the desktop port; other shells report none.

import { useSyncExternalStore, type CSSProperties, type ReactNode } from 'react'
import { Tooltip } from '../../kernel/interaction'
import { desktopPort, subscribeDesktopPort } from '../desktop'
import { useUIStore } from '../state/uiStore'

const REOPEN_BUTTON_WIDTH = 40

/** The sidebar toggle's glyph: a window with the sidebar split on the left. The
 *  sidebar pane fills in while the sidebar is hidden, and the fill fades as it
 *  opens or closes. */
export function SidebarToggleIcon({ filled, size = 16 }: { filled: boolean; size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M5 3h4v18H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" fill="currentColor" stroke="none" style={{ opacity: filled ? 0.9 : 0, transition: 'opacity 200ms ease-in-out' }} />
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M9 3v18" />
    </svg>
  )
}

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
      style={{ height: 36, paddingLeft: controls || 8, WebkitAppRegion: 'no-drag' } as CSSProperties}
    >
      <Tooltip action="toggleSidebar" label="Show sidebar" placement="bottom">
        <button
          type="button"
          aria-label="Show sidebar"
          onClick={() => useUIStore.getState().setSidebarHidden(false)}
          className="flex items-center justify-center w-6 h-6 rounded-md text-muted hover:text-primary hover:bg-hover transition-colors"
        >
          <SidebarToggleIcon filled />
        </button>
      </Tooltip>
    </div>
  )
}

/** Fixed chrome of an application overlay. */
export function OverlayHeader({ title, children, toolbar, fade = true }: {
  title: string
  children?: ReactNode
  toolbar?: ReactNode
  fade?: boolean
}): JSX.Element {
  const inset = useLeftChromeInset()
  return (
    <header
      className={`relative z-10 shrink-0 bg-canvas-bg text-primary ${fade ? 'after:pointer-events-none after:absolute after:inset-x-0 after:top-full after:h-6 after:bg-gradient-to-b after:from-canvas-bg after:to-transparent' : ''}`}
    >
      <div className="flex h-9 items-center gap-2 pl-6 pr-2" style={{ paddingLeft: Math.max(24, inset) }}>
        <h1 className="min-w-0 flex-1 truncate text-[13px] font-medium">{title}</h1>
        {children && <div className="flex shrink-0 items-center gap-2">{children}</div>}
      </div>
      {toolbar}
    </header>
  )
}
