// =============================================================================
// BrowserTabStrip — a horizontal Safari-style tab bar rendered directly under
// the URL bar. Pinned tabs come first as compact favicon-only chips; the rest
// render as favicon + title, with the active tab lifted onto a lighter surface.
// A trailing "+" opens a new tab. Middle-click closes a tab; right-click toggles
// its pinned state (keeping the gestures the old vertical sidebar used).
//
// Shown only when there is more than one tab or any pinned tab, so single-tab
// browsing stays chrome-free.
// =============================================================================
import { Plus, X } from '@phosphor-icons/react'
import type { BrowserTab } from '../../shared/types'
import { BrowserFavicon } from './BrowserFavicon'
import { faviconForUrl } from './browserUrl'
import { Tooltip } from '../ui/Tooltip'

interface Props {
  tabs: BrowserTab[]
  activeTabId: string
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onNewTab: () => void
  onTogglePin: (id: string) => void
}

export function BrowserTabStrip({ tabs, activeTabId, onSelect, onClose, onNewTab, onTogglePin }: Props): JSX.Element | null {
  const pinned = tabs.filter((t) => t.pinned)
  const unpinned = tabs.filter((t) => !t.pinned)

  // Chrome-free single-tab browsing: nothing to strip until there are choices.
  if (tabs.length <= 1 && pinned.length === 0) return null

  return (
    <div className="flex items-stretch gap-1 px-2 h-9 border-b border-subtle bg-surface-1 overflow-x-auto no-scrollbar shrink-0">
      {/* Pinned — favicon-only chips */}
      {pinned.map((tab) => {
        const isActive = tab.id === activeTabId
        return (
          <Tooltip key={tab.id} label={`${tab.title || tab.url} · right-click to unpin`}>
            <button
              onClick={() => onSelect(tab.id)}
              onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); onClose(tab.id) } }}
              onContextMenu={(e) => { e.preventDefault(); onTogglePin(tab.id) }}
              className={`my-1 w-8 flex items-center justify-center rounded-[10px] transition-colors ${
                isActive ? 'bg-surface-4 text-primary' : 'text-muted hover:bg-hover'
              }`}
              aria-label={tab.title || tab.url}
            >
              <BrowserFavicon src={tab.favicon ?? faviconForUrl(tab.url)} size={15} />
            </button>
          </Tooltip>
        )
      })}

      {/* Divider between pinned chips and the regular tabs */}
      {pinned.length > 0 && unpinned.length > 0 && (
        <div className="my-2 w-px bg-subtle shrink-0" />
      )}

      {/* Regular tabs — favicon + title */}
      {unpinned.map((tab) => {
        const isActive = tab.id === activeTabId
        return (
          <div
            key={tab.id}
            onClick={() => onSelect(tab.id)}
            onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); onClose(tab.id) } }}
            onContextMenu={(e) => { e.preventDefault(); onTogglePin(tab.id) }}
            title={`${tab.title || tab.url || 'New tab'} · right-click to pin`}
            className={`group my-1 flex items-center gap-1.5 pl-2 pr-1.5 min-w-[100px] max-w-[200px] rounded-[10px] cursor-pointer select-none transition-colors ${
              isActive ? 'bg-surface-4 text-primary' : 'text-muted hover:text-secondary hover:bg-hover'
            }`}
          >
            <BrowserFavicon src={tab.favicon ?? faviconForUrl(tab.url)} size={14} />
            <span className="truncate flex-1 min-w-0 text-xs">{tab.title || tab.url || 'New tab'}</span>
            <button
              onClick={(e) => { e.stopPropagation(); onClose(tab.id) }}
              className={`shrink-0 w-4 h-4 flex items-center justify-center rounded text-muted hover:text-red-400 hover:bg-hover transition-opacity ${
                isActive ? 'opacity-70' : 'opacity-0 group-hover:opacity-100'
              }`}
              aria-label="Close tab"
            >
              <X size={11} />
            </button>
          </div>
        )
      })}

      {/* New tab */}
      <Tooltip label="New tab">
        <button
          onClick={onNewTab}
          className="my-1 w-8 flex items-center justify-center rounded-[10px] text-muted hover:text-secondary hover:bg-hover transition-colors shrink-0"
          aria-label="New tab"
        >
          <Plus size={14} />
        </button>
      </Tooltip>
    </div>
  )
}
