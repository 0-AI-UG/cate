// =============================================================================
// BrowserTabSidebar — a vertical tab sidebar (Arc/Edge-style) for a browser
// panel. Pinned ("fixed") tabs render as a compact icon grid at the top; the
// rest are a vertical list. "New tab" sits at the bottom. Replaces the
// horizontal tab strip, which stacked awkwardly under Cate's own panel tab.
// =============================================================================
import { Plus, X, Globe } from '@phosphor-icons/react'
import type { BrowserTab } from '../../shared/types'

interface Props {
  tabs: BrowserTab[]
  activeTabId: string
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onNewTab: () => void
  onTogglePin: (id: string) => void
}

export function BrowserTabSidebar({ tabs, activeTabId, onSelect, onClose, onNewTab, onTogglePin }: Props): JSX.Element {
  const pinned = tabs.filter((t) => t.pinned)
  const unpinned = tabs.filter((t) => !t.pinned)

  return (
    <div className="w-48 shrink-0 h-full flex flex-col border-r border-subtle bg-surface-1">
      {/* Pinned tabs — compact icon tiles */}
      {pinned.length > 0 && (
        <div className="grid grid-cols-4 gap-1 p-2 border-b border-subtle">
          {pinned.map((tab) => (
            <button
              key={tab.id}
              onClick={() => onSelect(tab.id)}
              onContextMenu={(e) => { e.preventDefault(); onTogglePin(tab.id) }}
              title={`${tab.title || tab.url} (right-click to unpin)`}
              className={`aspect-square flex items-center justify-center rounded-md border transition-colors ${
                tab.id === activeTabId
                  ? 'border-agent bg-agent/15 text-agent'
                  : 'border-subtle bg-surface-5 hover:bg-hover text-muted'
              }`}
            >
              <Globe size={15} />
            </button>
          ))}
        </div>
      )}

      {/* Unpinned tabs — vertical list */}
      <div className="flex-1 overflow-y-auto py-1">
        {unpinned.map((tab) => {
          const isActive = tab.id === activeTabId
          return (
            <div
              key={tab.id}
              onClick={() => onSelect(tab.id)}
              onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); onClose(tab.id) } }}
              onContextMenu={(e) => { e.preventDefault(); onTogglePin(tab.id) }}
              title={`${tab.title || tab.url} (right-click to pin)`}
              className={`group flex items-center gap-2 mx-1.5 my-0.5 px-2 h-8 rounded-md cursor-pointer select-none transition-colors ${
                isActive ? 'bg-surface-3 text-secondary' : 'text-muted hover:text-secondary hover:bg-hover'
              }`}
            >
              <Globe size={13} className={`shrink-0 ${isActive ? 'text-agent' : 'text-muted'}`} />
              <span className="truncate flex-1 min-w-0 text-xs">{tab.title || tab.url || 'New tab'}</span>
              <button
                onClick={(e) => { e.stopPropagation(); onClose(tab.id) }}
                className={`shrink-0 p-0.5 rounded-sm hover:bg-hover ${isActive ? 'opacity-80' : 'opacity-0 group-hover:opacity-70'}`}
                aria-label="Close tab"
              >
                <X size={11} />
              </button>
            </div>
          )
        })}
      </div>

      {/* New tab */}
      <button
        onClick={onNewTab}
        className="flex items-center gap-2 px-3 h-9 border-t border-subtle text-muted hover:text-secondary hover:bg-hover transition-colors shrink-0"
        aria-label="New tab"
      >
        <Plus size={14} />
        <span className="text-xs">New tab</span>
      </button>
    </div>
  )
}
