// =============================================================================
// UrlSuggestions — autocomplete dropdown beneath the browser URL bar. Pure
// presentational: the parent (BrowserPanel) owns the query + active selection.
// =============================================================================
import type { BrowserHistoryEntry } from '../../shared/types'
import { POPOVER_SURFACE } from '../ui/Popover'
import { BrowserFavicon } from './BrowserFavicon'
import { faviconForUrl } from './browserUrl'

interface Props {
  items: BrowserHistoryEntry[]
  activeIndex: number
  onPick: (url: string) => void
  onHover: (index: number) => void
}

export function UrlSuggestions({ items, activeIndex, onPick, onHover }: Props): JSX.Element | null {
  if (items.length === 0) return null
  return (
    <div className={`absolute left-0 right-0 top-full mt-1 z-30 ${POPOVER_SURFACE} overflow-hidden p-1.5`}>
      {items.map((item, i) => (
        <button
          key={item.url}
          // onMouseDown (not onClick) so the pick fires before the input's onBlur
          // hides the list; preventDefault keeps focus where it is.
          onMouseDown={(e) => { e.preventDefault(); onPick(item.url) }}
          onMouseEnter={() => onHover(i)}
          className={`w-full flex items-center gap-2.5 rounded-lg px-2.5 h-9 text-left text-[13px] hover:bg-hover focus-visible:bg-hover transition-colors duration-100 motion-reduce:transition-none ${
            i === activeIndex ? 'bg-hover' : ''
          }`}
        >
          <BrowserFavicon src={faviconForUrl(item.url)} size={16} />
          <span className="min-w-0 max-w-[60%] shrink-0 truncate text-primary">{item.title || item.url}</span>
          <span className="min-w-0 truncate text-secondary">
            <span aria-hidden="true">· </span>
            {item.url.replace(/^https?:\/\/(?:www\.)?/, '').replace(/\/$/, '')}
          </span>
        </button>
      ))}
    </div>
  )
}
