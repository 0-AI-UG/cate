// =============================================================================
// BrowserTabStrip — the in-panel tab row for a browser panel (light tab model).
// Pinned ("fixed") tabs sort left, render compact, and have no close button.
// Styling mirrors the dock tab bar so tabs feel native to Cate.
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

export function BrowserTabStrip({ tabs, activeTabId, onSelect, onClose, onNewTab, onTogglePin }: Props): JSX.Element {
  // Pinned first; stable sort preserves each group's relative order.
  const ordered = [...tabs].sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned))

  return (
    <div className="flex items-stretch h-9 bg-surface-1 border-b border-subtle shrink-0 overflow-x-auto">
      {ordered.map((tab) => {
        const isActive = tab.id === activeTabId
        return (
          <div
            key={tab.id}
            onClick={() => onSelect(tab.id)}
            onAuxClick={(e) => { if (e.button === 1 && !tab.pinned) { e.preventDefault(); onClose(tab.id) } }}
            onContextMenu={(e) => { e.preventDefault(); onTogglePin(tab.id) }}
            title={tab.pinned ? `${tab.title || tab.url} (right-click to unpin)` : `${tab.title || tab.url} (right-click to pin)`}
            className={`group relative flex items-center gap-1.5 cursor-pointer select-none border-r border-subtle min-w-0 ${
              tab.pinned ? 'px-2.5 justify-center w-9' : 'px-3 shrink max-w-[180px]'
            } ${isActive ? 'bg-surface-3 text-secondary' : 'text-muted hover:text-secondary hover:bg-hover'}`}
          >
            <Globe size={13} className={`shrink-0 ${isActive ? 'text-agent' : 'text-muted'}`} />
            {!tab.pinned && (
              <span className="truncate flex-1 min-w-0 text-xs">{tab.title || tab.url || 'New tab'}</span>
            )}
            {!tab.pinned && (
              <button
                onClick={(e) => { e.stopPropagation(); onClose(tab.id) }}
                className={`shrink-0 p-0.5 rounded-sm hover:bg-hover ${isActive ? 'opacity-80' : 'opacity-0 group-hover:opacity-70'}`}
                aria-label="Close tab"
              >
                <X size={11} />
              </button>
            )}
          </div>
        )
      })}
      <button
        onClick={onNewTab}
        className="shrink-0 w-8 flex items-center justify-center text-muted hover:text-secondary hover:bg-hover transition-colors"
        aria-label="New tab"
        title="New tab"
      >
        <Plus size={14} />
      </button>
    </div>
  )
}
