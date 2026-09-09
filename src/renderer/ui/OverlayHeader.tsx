import type { ReactNode } from 'react'
import { useLeftChromeInset } from '../shells/LeftSidebarReopen'

/** Shared title chrome for application overlays; view navigation belongs in the content. */
export function OverlayHeader({ title, children }: { title: string; children?: ReactNode }) {
  const inset = useLeftChromeInset()
  return (
    <header className="relative z-10 flex h-11 shrink-0 items-center gap-2 bg-canvas-bg px-6 text-primary after:pointer-events-none after:absolute after:inset-x-0 after:top-full after:h-6 after:bg-gradient-to-b after:from-canvas-bg after:to-transparent" style={{ paddingLeft: Math.max(24, inset) }}>
      <h1 className="min-w-0 flex-1 truncate text-[13px] font-medium">{title}</h1>
      {children && <div className="flex shrink-0 items-center gap-2">{children}</div>}
    </header>
  )
}
