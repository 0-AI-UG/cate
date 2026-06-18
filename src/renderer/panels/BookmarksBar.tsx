// =============================================================================
// BookmarksBar — a thin horizontal strip of favorite chips under the URL bar,
// like Chrome's bookmarks bar. Fed by the shared global browserStore.bookmarks
// so it is identical across every browser panel and window. Left-click
// navigates the active tab; right-click removes the bookmark.
// =============================================================================
import { Globe } from '@phosphor-icons/react'
import { useBrowserStore } from '../stores/browserStore'

interface Props {
  /** Navigate the active tab to a bookmarked URL. */
  onNavigate: (url: string) => void
}

export function BookmarksBar({ onNavigate }: Props): JSX.Element | null {
  const bookmarks = useBrowserStore((s) => s.bookmarks)
  const removeBookmark = useBrowserStore((s) => s.toggleBookmark)

  if (bookmarks.length === 0) return null

  return (
    <div className="flex items-center gap-1 px-2 h-8 border-b border-subtle bg-surface-1 overflow-x-auto shrink-0">
      {bookmarks.map((b) => (
        <button
          key={b.url}
          onClick={() => onNavigate(b.url)}
          onContextMenu={(e) => { e.preventDefault(); removeBookmark(b.url, b.title) }}
          title={`${b.title || b.url}\n(right-click to remove)`}
          className="flex items-center gap-1.5 px-2 h-6 rounded shrink-0 text-xs text-secondary hover:bg-hover transition-colors max-w-[160px]"
        >
          <Globe size={12} className="text-muted shrink-0" />
          <span className="truncate">{b.title || b.url}</span>
        </button>
      ))}
    </div>
  )
}
