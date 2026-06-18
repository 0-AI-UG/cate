// =============================================================================
// StartPage — the browser "new tab" page. A centered search box plus global
// favorites + recently visited pages, so a fresh browser panel is a useful
// launchpad like Chrome's new-tab page. Data comes from the shared browserStore.
// =============================================================================
import { useState } from 'react'
import { Globe, Star, MagnifyingGlass } from '@phosphor-icons/react'
import { useBrowserStore } from '../stores/browserStore'

interface Props {
  /** Navigate the active tab. Accepts a URL or a search query (the panel's
   *  navigateTo decides which and routes searches to the configured engine). */
  onNavigate: (input: string) => void
}

export function StartPage({ onNavigate }: Props): JSX.Element {
  const bookmarks = useBrowserStore((s) => s.bookmarks)
  const history = useBrowserStore((s) => s.history)
  const recent = [...history].sort((a, b) => b.lastVisited - a.lastVisited).slice(0, 8)
  const [query, setQuery] = useState('')

  const submit = (): void => {
    const q = query.trim()
    if (q) onNavigate(q)
  }

  return (
    <div className="w-full h-full overflow-auto bg-surface-0 px-8 py-12">
      <div className="max-w-2xl mx-auto flex flex-col items-center">
        {/* Hero search */}
        <div className="w-14 h-14 rounded-2xl bg-surface-5 border border-subtle flex items-center justify-center mb-6">
          <Globe size={28} className="text-agent" />
        </div>
        <div className="w-full max-w-xl flex items-center h-11 rounded-full border border-subtle bg-surface-5 px-4 gap-2.5 focus-within:border-strong transition-colors shadow-sm">
          <MagnifyingGlass size={16} className="text-muted shrink-0" />
          <input
            autoFocus
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit() } }}
            className="flex-1 h-full bg-transparent text-base text-primary outline-none placeholder:text-muted"
            placeholder="Search the web or enter a URL"
          />
        </div>

        {/* Favorites */}
        <section className="w-full mt-12">
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

        {/* Recently visited */}
        <section className="w-full mt-8">
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
