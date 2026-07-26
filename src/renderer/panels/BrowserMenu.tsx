// =============================================================================
// BrowserMenu — the URL-bar overflow (⋮) dropdown for a browser panel.
// =============================================================================
import { useEffect, useRef, useState, type RefObject } from 'react'
import { BookmarkSimple, CaretLeft, Minus, Plus, Gear, Key } from '@phosphor-icons/react'
import { useBrowserStore } from '../stores/browserStore'
import { useUIStore } from '../stores/uiStore'
import { BrowserFavicon } from './BrowserFavicon'
import { faviconForUrl } from './browserUrl'

interface Props {
  onNewTab: () => void
  onNavigate: (url: string) => void
  onOpenPasswordManager: () => void
  zoomPercent: number
  onZoomOut: () => void
  onZoomIn: () => void
  onZoomReset: () => void
  onClose: () => void
  triggerRef: RefObject<HTMLElement | null>
}

export function BrowserMenu({
  onNewTab,
  onNavigate,
  onOpenPasswordManager,
  zoomPercent,
  onZoomOut,
  onZoomIn,
  onZoomReset,
  onClose,
  triggerRef,
}: Props): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [bookmarksOpen, setBookmarksOpen] = useState(false)
  const bookmarks = useBrowserStore((s) => s.bookmarks)

  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      const target = e.target as Node
      if (
        ref.current
        && !ref.current.contains(target)
        && !triggerRef.current?.contains(target)
      ) onClose()
    }
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose() }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose, triggerRef])

  const item = 'w-full flex items-center gap-2.5 px-3 h-8 text-sm text-secondary hover:bg-hover transition-colors text-left'

  return (
    <div
      ref={ref}
      className="absolute right-2 top-[5.5rem] z-40 w-56 rounded-lg border border-subtle bg-surface-2 shadow-2xl py-1"
      onMouseDown={(e) => e.stopPropagation()}
    >
      <button className={item} onClick={() => { onClose(); onNewTab() }}>
        <Plus size={14} className="text-muted" /> New tab
      </button>
      <div
        className="relative"
        onMouseEnter={() => setBookmarksOpen(true)}
        onMouseLeave={() => setBookmarksOpen(false)}
        onFocus={() => setBookmarksOpen(true)}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            setBookmarksOpen(false)
          }
        }}
      >
        <button
          className={item}
          aria-haspopup="menu"
          aria-expanded={bookmarksOpen}
        >
          <BookmarkSimple size={14} className="text-muted" />
          <span className="flex-1">Bookmarks</span>
          <CaretLeft size={12} className="text-muted" />
        </button>
        {bookmarksOpen && (
          <div
            role="menu"
            aria-label="Bookmarks"
            className="absolute right-[calc(100%-4px)] top-0 z-50 max-h-80 w-64 overflow-y-auto rounded-lg border border-subtle bg-surface-2 py-1 shadow-2xl"
          >
            {bookmarks.length === 0 ? (
              <div className="px-3 py-2 text-xs text-muted">No bookmarks yet</div>
            ) : bookmarks.map((bookmark) => (
              <button
                key={bookmark.url}
                role="menuitem"
                title={bookmark.url}
                className="flex h-8 w-full items-center gap-2.5 px-3 text-left text-sm text-secondary transition-colors hover:bg-hover"
                onClick={() => {
                  onClose()
                  onNavigate(bookmark.url)
                }}
              >
                <BrowserFavicon src={faviconForUrl(bookmark.url)} size={13} />
                <span className="min-w-0 flex-1 truncate">{bookmark.title || bookmark.url}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <button className={item} onClick={() => { onClose(); onOpenPasswordManager() }}>
        <Key size={14} className="text-muted" /> Passwords and autofill
      </button>
      <div className="my-1 border-t border-subtle" />
      <div className="flex h-9 items-center gap-1 px-3 text-sm text-secondary">
        <span className="flex-1">Zoom</span>
        <button
          type="button"
          onClick={onZoomOut}
          disabled={zoomPercent <= 25}
          className="flex h-7 w-7 items-center justify-center rounded-md text-secondary transition-colors hover:bg-hover hover:text-primary disabled:opacity-30"
          aria-label="Zoom out"
        >
          <Minus size={13} />
        </button>
        <button
          type="button"
          onClick={onZoomReset}
          className="h-7 min-w-12 rounded-md px-1 text-center text-xs tabular-nums text-secondary transition-colors hover:bg-hover hover:text-primary"
          aria-label="Reset zoom"
        >
          {zoomPercent}%
        </button>
        <button
          type="button"
          onClick={onZoomIn}
          disabled={zoomPercent >= 500}
          className="flex h-7 w-7 items-center justify-center rounded-md text-secondary transition-colors hover:bg-hover hover:text-primary disabled:opacity-30"
          aria-label="Zoom in"
        >
          <Plus size={13} />
        </button>
      </div>
      <div className="my-1 border-t border-subtle" />
      <button
        className={item}
        onClick={() => {
          onClose()
          useUIStore.getState().openSettings('browser')
        }}
      >
        <Gear size={14} className="text-muted" /> Browser settings…
      </button>
    </div>
  )
}
