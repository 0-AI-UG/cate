// =============================================================================
// BrowserMenu — the URL-bar overflow (⋮) dropdown for a browser panel: new tab,
// toggle the bookmarks bar, and open the in-panel browser settings popover.
// =============================================================================
import { useEffect, useRef } from 'react'
import { Plus, BookmarkSimple, Gear, Check } from '@phosphor-icons/react'
import { useSettingsStore } from '../stores/settingsStore'

interface Props {
  onNewTab: () => void
  onOpenSettings: () => void
  onClose: () => void
}

export function BrowserMenu({ onNewTab, onOpenSettings, onClose }: Props): JSX.Element {
  const showBookmarksBar = useSettingsStore((s) => s.browserShowBookmarksBar)
  const setSetting = useSettingsStore((s) => s.setSetting)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose() }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  const item = 'w-full flex items-center gap-2.5 px-3 h-8 text-sm text-secondary hover:bg-hover transition-colors text-left'

  return (
    <div
      ref={ref}
      className="absolute right-2 top-12 z-40 w-56 rounded-lg border border-subtle bg-surface-2 shadow-2xl py-1"
      onMouseDown={(e) => e.stopPropagation()}
    >
      <button className={item} onClick={() => { onClose(); onNewTab() }}>
        <Plus size={14} className="text-muted" /> New tab
      </button>
      <button
        className={item}
        onClick={() => setSetting('browserShowBookmarksBar', !showBookmarksBar)}
      >
        <BookmarkSimple size={14} className="text-muted" />
        <span className="flex-1">Show bookmarks bar</span>
        {showBookmarksBar && <Check size={14} className="text-agent" />}
      </button>
      <div className="my-1 border-t border-subtle" />
      <button className={item} onClick={() => { onClose(); onOpenSettings() }}>
        <Gear size={14} className="text-muted" /> Browser settings…
      </button>
    </div>
  )
}
