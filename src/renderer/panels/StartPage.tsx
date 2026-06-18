// =============================================================================
// StartPage — the browser "new tab" page. Shows global favorites + recently
// visited pages so a fresh browser panel is a useful launchpad, like Chrome's
// new-tab page. Data comes from the shared browserStore.
// =============================================================================
import { Globe, Star } from '@phosphor-icons/react'
import { useBrowserStore } from '../stores/browserStore'

interface Props { onNavigate: (url: string) => void }

export function StartPage({ onNavigate }: Props): JSX.Element {
  const bookmarks = useBrowserStore((s) => s.bookmarks)
  const history = useBrowserStore((s) => s.history)
  const recent = [...history].sort((a, b) => b.lastVisited - a.lastVisited).slice(0, 12)

  return (
    <div className="w-full h-full overflow-auto bg-surface-0 p-8">
      <div className="max-w-3xl mx-auto space-y-8">
        <section>
          <h2 className="text-xs uppercase tracking-wide text-muted mb-3 flex items-center gap-1.5">
            <Star size={12} /> Favorites
          </h2>
          {bookmarks.length === 0 ? (
            <p className="text-sm text-muted">No bookmarks yet — star a page to add it here.</p>
          ) : (
            <div className="grid grid-cols-4 gap-3">
              {bookmarks.map((b) => (
                <button
                  key={b.url}
                  onClick={() => onNavigate(b.url)}
                  className="flex flex-col items-start gap-1 p-3 rounded-lg border border-subtle bg-surface-5 hover:bg-hover text-left transition-colors"
                >
                  <Globe size={16} className="text-muted" />
                  <span className="text-sm text-primary truncate w-full">{b.title || b.url}</span>
                  <span className="text-xs text-muted truncate w-full">{b.url}</span>
                </button>
              ))}
            </div>
          )}
        </section>
        <section>
          <h2 className="text-xs uppercase tracking-wide text-muted mb-3">Recently visited</h2>
          {recent.length === 0 ? (
            <p className="text-sm text-muted">Pages you visit will show up here.</p>
          ) : (
            <div className="space-y-1">
              {recent.map((h) => (
                <button
                  key={h.url}
                  onClick={() => onNavigate(h.url)}
                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded hover:bg-hover text-left transition-colors"
                >
                  <span className="text-sm text-primary truncate">{h.title || h.url}</span>
                  <span className="text-xs text-muted truncate ml-auto">{h.url}</span>
                </button>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
