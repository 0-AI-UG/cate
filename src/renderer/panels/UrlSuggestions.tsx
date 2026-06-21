// =============================================================================
// UrlSuggestions — autocomplete dropdown beneath the browser URL bar. Pure
// presentational: the parent (BrowserPanel) owns the query + active selection.
// =============================================================================
import type { BrowserHistoryEntry } from '../../shared/types'

interface Props {
  items: BrowserHistoryEntry[]
  activeIndex: number
  onPick: (url: string) => void
  onHover: (index: number) => void
}

export function UrlSuggestions({ items, activeIndex, onPick, onHover }: Props): JSX.Element | null {
  if (items.length === 0) return null
  return (
    <div className="absolute left-0 right-0 top-full mt-1 z-30 rounded-lg border border-subtle bg-surface-5 shadow-2xl overflow-hidden">
      {items.map((item, i) => (
        <button
          key={item.url}
          // onMouseDown (not onClick) so the pick fires before the input's onBlur
          // hides the list; preventDefault keeps focus where it is.
          onMouseDown={(e) => { e.preventDefault(); onPick(item.url) }}
          onMouseEnter={() => onHover(i)}
          className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-sm ${
            i === activeIndex ? 'bg-hover' : ''
          }`}
        >
          <span className="text-primary truncate">{item.title || item.url}</span>
          <span className="text-muted truncate ml-auto text-xs">{item.url}</span>
        </button>
      ))}
    </div>
  )
}
