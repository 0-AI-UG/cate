import { useMemo, useState } from 'react'
import { ClockCounterClockwise, MagnifyingGlass, Trash } from '@phosphor-icons/react'
import { useBrowserStore } from '../stores/browserStore'
import { SecondaryButton } from '../settings/SettingsComponents'
import { BrowserFavicon } from './BrowserFavicon'
import { faviconForUrl } from './browserUrl'

interface Props {
  onNavigate: (url: string) => void
}

export function BrowserHistoryPage({ onNavigate }: Props): JSX.Element {
  const [query, setQuery] = useState('')
  const history = useBrowserStore((state) => state.history)
  const removeHistory = useBrowserStore((state) => state.removeHistory)
  const clearHistory = useBrowserStore((state) => state.clearHistory)

  const filteredHistory = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return history
    return history.filter((entry) =>
      entry.title.toLowerCase().includes(needle) || entry.url.toLowerCase().includes(needle))
  }, [history, query])

  const clearAll = (): void => {
    if (!window.confirm('Clear all browsing history in Cate?')) return
    clearHistory()
  }

  return (
    <div
      data-browser-history
      className="absolute inset-0 h-full w-full overflow-y-auto bg-surface-0 text-primary"
    >
      <div className="mx-auto flex min-h-full w-full max-w-4xl flex-col px-10 py-10">
        <div className="mb-7 flex items-center gap-3">
          <ClockCounterClockwise size={26} className="text-secondary" />
          <h1 className="text-2xl font-semibold">History</h1>
        </div>

        <div className="mb-6 flex items-center gap-3">
          <label className="relative block min-w-0 flex-1">
            <MagnifyingGlass
              size={15}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted"
            />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search history"
              className="w-full rounded-lg border border-subtle bg-surface-2 py-2 pl-9 pr-3 text-sm outline-none focus:border-focus-blue"
            />
          </label>
          <SecondaryButton onClick={clearAll} disabled={history.length === 0}>
            Clear history
          </SecondaryButton>
        </div>

        <div className="overflow-hidden rounded-xl border border-subtle bg-surface-1">
          {filteredHistory.length === 0 ? (
            <div className="px-5 py-12 text-center text-sm text-muted">
              {history.length === 0 ? 'No browsing history' : 'No matching history'}
            </div>
          ) : filteredHistory.map((entry) => (
            <div
              key={entry.url}
              className="flex items-center gap-3 border-b border-subtle px-4 py-3 last:border-b-0"
            >
              <BrowserFavicon src={faviconForUrl(entry.url)} size={18} />
              <button
                type="button"
                className="min-w-0 flex-1 text-left"
                onClick={() => onNavigate(entry.url)}
              >
                <div className="truncate text-sm font-medium">{entry.title || entry.url}</div>
                <div className="mt-0.5 flex gap-2 text-xs text-muted">
                  <span className="truncate">{entry.url}</span>
                  <span className="shrink-0">{new Date(entry.lastVisited).toLocaleString()}</span>
                </div>
              </button>
              <button
                type="button"
                onClick={() => removeHistory(entry.url)}
                className="rounded-lg p-2 text-muted hover:bg-hover hover:text-primary"
                aria-label={`Remove ${entry.title || entry.url} from history`}
              >
                <Trash size={15} />
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
