// =============================================================================
// BrowserBookmarksSidebar — a vertical Safari-style sidebar listing the user's
// bookmarks. Occupies the slot the old vertical tab list vacated (tabs now live
// in the horizontal BrowserTabStrip). Fed by the shared global browserStore, so
// it is identical across every browser panel and window. Click navigates the
// active tab; the × (or right-click) removes a bookmark. Toggled by the URL-bar
// sidebar button.
// =============================================================================
import { X, BookmarkSimple } from '@phosphor-icons/react'
import { useBrowserStore } from '../stores/browserStore'
import { BrowserFavicon } from './BrowserFavicon'
import { faviconForUrl } from './browserUrl'

interface Props {
  /** Navigate the active tab to a bookmarked URL. */
  onNavigate: (url: string) => void
}

export function BrowserBookmarksSidebar({ onNavigate }: Props): JSX.Element {
  const bookmarks = useBrowserStore((s) => s.bookmarks)
  const removeBookmark = useBrowserStore((s) => s.toggleBookmark)

  return (
    <div className="w-52 shrink-0 h-full flex flex-col border-r border-subtle bg-surface-1">
      <div className="flex items-center gap-2 px-3 h-10 shrink-0">
        <BookmarkSimple size={13} className="text-muted" />
        <span className="text-[11px] font-medium text-muted uppercase tracking-wide">Bookmarks</span>
      </div>

      {bookmarks.length === 0 ? (
        <div className="flex-1 flex items-center justify-center px-4 text-center">
          <span className="text-xs text-muted">Star a page to bookmark it here.</span>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto py-1">
          {bookmarks.map((b) => (
            <div
              key={b.url}
              onClick={() => onNavigate(b.url)}
              onContextMenu={(e) => { e.preventDefault(); removeBookmark(b.url, b.title) }}
              title={`${b.title || b.url}\n(right-click to remove)`}
              className="group flex items-center gap-2 mx-1.5 my-0.5 px-2 h-8 rounded-md cursor-pointer select-none text-muted hover:text-secondary hover:bg-hover transition-colors"
            >
              <BrowserFavicon src={faviconForUrl(b.url)} size={13} />
              <span className="truncate flex-1 min-w-0 text-xs">{b.title || b.url}</span>
              <button
                onClick={(e) => { e.stopPropagation(); removeBookmark(b.url, b.title) }}
                className="shrink-0 w-4 h-4 flex items-center justify-center rounded text-muted hover:text-red-400 hover:bg-hover opacity-0 group-hover:opacity-100 transition-opacity"
                aria-label="Remove bookmark"
              >
                <X size={11} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
