// =============================================================================
// BrowserMenu — the URL-bar overflow (⋮) dropdown for a browser panel.
// =============================================================================
import { useEffect, useRef, useState, type RefObject } from 'react'
import { Bookmark as BookmarkSimple, ChevronLeft as CaretLeft, History as ClockCounterClockwise, Minus, Plus, Settings as Gear, Key } from 'lucide-react'
import { useBrowserStore } from '../stores/browserStore'
import { useUIStore } from '../stores/uiStore'
import { BrowserFavicon } from './BrowserFavicon'
import { faviconForUrl } from './browserUrl'
import { POPOVER_SURFACE, useDismissableLayer } from '../ui/Popover'
import type { BrowserViewport } from '../lib/portalRegistry'

interface Props {
  onNewTab: () => void
  onNavigate: (url: string) => void
  onOpenHistory: () => void
  onOpenPasswordManager: () => void
  zoomPercent: number
  onZoomOut: () => void
  onZoomIn: () => void
  onZoomReset: () => void
  viewport: BrowserViewport
  onViewportChange: (viewport: BrowserViewport) => void
  onClose: () => void
  triggerRef: RefObject<HTMLElement | null>
}

export function BrowserMenu({
  onNewTab,
  onNavigate,
  onOpenHistory,
  onOpenPasswordManager,
  zoomPercent,
  onZoomOut,
  onZoomIn,
  onZoomReset,
  viewport,
  onViewportChange,
  onClose,
  triggerRef,
}: Props): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [bookmarksOpen, setBookmarksOpen] = useState(false)
  const bookmarks = useBrowserStore((s) => s.bookmarks)
  const [width, setWidth] = useState('')
  const [height, setHeight] = useState('')
  useEffect(() => {
    setWidth(viewport.preset === 'compact' ? '1280' : String(viewport.width))
    setHeight(viewport.preset === 'compact' ? '800' : String(viewport.height))
  }, [viewport])
  const validSize = Number.isSafeInteger(Number(width)) && Number(width) > 0
    && Number.isSafeInteger(Number(height)) && Number(height) > 0

  useDismissableLayer({ open: true, contentRef: ref, triggerRefs: [triggerRef], onDismiss: onClose })

  const item = 'w-full flex items-center gap-2.5 rounded-lg px-2.5 h-8 text-[13px] text-primary hover:bg-hover focus-visible:bg-hover transition-colors duration-100 motion-reduce:transition-none text-left'

  return (
    <div
      ref={ref}
      className={`absolute right-2 top-[5.5rem] z-40 w-60 max-w-[calc(100%-16px)] ${POPOVER_SURFACE} p-1.5`}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <button className={item} onClick={() => { onClose(); onNewTab() }}>
        <Plus size={16} className="shrink-0 text-secondary" /> New tab
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
          <BookmarkSimple size={16} className="shrink-0 text-secondary" />
          <span className="flex-1">Bookmarks</span>
          <CaretLeft size={12} className="text-muted" />
        </button>
        {bookmarksOpen && (
          <div
            role="menu"
            aria-label="Bookmarks"
            className={`absolute right-[calc(100%-4px)] top-0 z-50 max-h-80 w-64 overflow-y-auto ${POPOVER_SURFACE} p-1.5`}
          >
            {bookmarks.length === 0 ? (
              <div className="px-3 py-2 text-xs text-muted">No bookmarks yet</div>
            ) : bookmarks.map((bookmark) => (
              <button
                key={bookmark.url}
                role="menuitem"
                title={bookmark.url}
                className={item}
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
      <button className={item} onClick={() => { onClose(); onOpenHistory() }}>
        <ClockCounterClockwise size={16} className="shrink-0 text-secondary" /> History
      </button>
      <button className={item} onClick={() => { onClose(); onOpenPasswordManager() }}>
        <Key size={16} className="shrink-0 text-secondary" /> Passwords and autofill
      </button>
      <div className="mx-2.5 my-1.5 border-t border-subtle" />
      <div className="flex h-9 items-center gap-3 px-2.5 text-[13px] text-primary">
        <span className="flex-1">Zoom</span>
        <div className="flex h-7 items-center overflow-hidden rounded-lg border border-subtle bg-surface-4">
          <button
            type="button"
            onClick={onZoomOut}
            disabled={zoomPercent <= 25}
            className="flex h-7 w-7 items-center justify-center text-secondary transition-colors hover:bg-hover hover:text-primary focus-visible:bg-hover disabled:opacity-30 disabled:hover:bg-transparent"
            aria-label="Zoom out"
          >
            <Minus size={13} />
          </button>
          <button
            type="button"
            onClick={onZoomReset}
            className="h-5 min-w-12 border-x border-subtle px-1.5 text-center text-xs tabular-nums text-primary transition-colors hover:bg-hover focus-visible:bg-hover"
            aria-label="Reset zoom"
          >
            {zoomPercent}%
          </button>
          <button
            type="button"
            onClick={onZoomIn}
            disabled={zoomPercent >= 500}
            className="flex h-7 w-7 items-center justify-center text-secondary transition-colors hover:bg-hover hover:text-primary focus-visible:bg-hover disabled:opacity-30 disabled:hover:bg-transparent"
            aria-label="Zoom in"
          >
            <Plus size={13} />
          </button>
        </div>
      </div>
      <label className="flex h-9 items-center gap-3 px-2.5 text-[13px] text-primary">
        <span className="flex-1">Viewport</span>
        <select
          aria-label="Viewport"
          className="h-7 min-w-0 rounded-lg border border-subtle bg-surface-4 px-1.5 text-xs text-primary"
          value={viewport.preset}
          onChange={(event) => {
            const preset = event.target.value
            if (preset === 'compact') onViewportChange({ preset: 'compact' })
            else if (preset === 'mobile') onViewportChange({ preset: 'mobile', width: 390, height: 844 })
            else if (preset === 'desktop') onViewportChange({ preset: 'desktop', width: 1280, height: 800 })
            else onViewportChange({
              preset: 'custom',
              width: viewport.preset === 'compact' ? 1280 : viewport.width,
              height: viewport.preset === 'compact' ? 800 : viewport.height,
            })
          }}
        >
          <option value="compact">Fit panel</option>
          <option value="desktop">Desktop</option>
          <option value="mobile">Mobile</option>
          <option value="custom">Custom</option>
        </select>
      </label>
      {viewport.preset !== 'compact' && (
        <form
          className="flex items-end gap-1.5 px-2.5 py-1.5"
          onSubmit={(event) => {
            event.preventDefault()
            if (validSize) onViewportChange({ preset: 'custom', width: Number(width), height: Number(height) })
          }}
        >
          <label className="min-w-0 flex-1 text-xs text-secondary">
            Width
            <input
              type="number" min="1" step="1" required value={width}
              onChange={(event) => setWidth(event.target.value)}
              className="mt-1 h-7 w-full rounded-lg border border-subtle bg-surface-4 px-1.5 text-xs text-primary"
            />
          </label>
          <label className="min-w-0 flex-1 text-xs text-secondary">
            Height
            <input
              type="number" min="1" step="1" required value={height}
              onChange={(event) => setHeight(event.target.value)}
              className="mt-1 h-7 w-full rounded-lg border border-subtle bg-surface-4 px-1.5 text-xs text-primary"
            />
          </label>
          <button
            type="submit" disabled={!validSize}
            className="h-7 rounded-lg border border-subtle px-2 text-xs text-primary hover:bg-hover focus-visible:bg-hover disabled:opacity-30"
          >
            Apply
          </button>
        </form>
      )}
      <div className="mx-2.5 my-1.5 border-t border-subtle" />
      <button
        className={item}
        onClick={() => {
          onClose()
          useUIStore.getState().openSettings('browser')
        }}
      >
        <Gear size={16} className="shrink-0 text-secondary" /> Browser settings…
      </button>
    </div>
  )
}
