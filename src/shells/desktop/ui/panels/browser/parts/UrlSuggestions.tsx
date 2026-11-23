// UrlSuggestions: the list that expands the browser URL bar's card. Pure
// presentational: the parent (BrowserPanel) owns the query + active selection.
import type { BrowserHistoryEntry } from '@services/browser/contract'
import { BrowserFavicon } from './BrowserFavicon'
import { faviconForUrl } from '@panels/browser/contract'

interface Props {
  items: BrowserHistoryEntry[]
  activeIndex: number
  onPick: (url: string) => void
  onHover: (index: number) => void
}

export function UrlSuggestions({ items, activeIndex, onPick, onHover }: Props): JSX.Element | null {
  if (items.length === 0) return null
  return (
    <div className="px-1 pb-1">
      {items.map((item, i) => {
        const shown = item.url.replace(/^https?:\/\/(?:www\.)?/, '').replace(/\/$/, '')
        const title = item.title && item.title !== item.url && item.title !== shown ? item.title : ''
        return (
          <button
            key={item.url}
            // onMouseDown (not onClick) so the pick fires before the input's onBlur
            // hides the list; preventDefault keeps focus where it is.
            onMouseDown={(e) => { e.preventDefault(); onPick(item.url) }}
            onMouseEnter={() => onHover(i)}
            className={`w-full flex items-center gap-2.5 rounded-lg px-2 h-8 text-left text-[13px] transition-colors duration-100 motion-reduce:transition-none ${
              i === activeIndex ? 'bg-hover' : ''
            }`}
          >
            <span className="opacity-60"><BrowserFavicon src={faviconForUrl(item.url)} size={14} /></span>
            {title && <span className="min-w-0 max-w-[50%] shrink-0 truncate text-primary">{title}</span>}
            <span className={`min-w-0 truncate ${title ? 'text-muted' : 'text-primary'}`}>{shown}</span>
          </button>
        )
      })}
    </div>
  )
}
