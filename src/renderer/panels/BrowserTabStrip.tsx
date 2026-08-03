// =============================================================================
// BrowserTabStrip — a horizontal Safari-style tab bar rendered directly above
// the URL bar. Pinned tabs come first as compact favicon-only chips; the rest
// render as favicon + title, with the active tab lifted onto a lighter surface.
// A trailing "+" opens a new tab. Middle-click closes a tab; right-click toggles
// its pinned state (keeping the gestures the old vertical sidebar used).
// =============================================================================
import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { Plus, X } from '@phosphor-icons/react'
import { isStartPageUrl, type BrowserTab } from '../../shared/types'
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
  const dragRef = useRef<{
    pointerId: number
    startX: number
    startY: number
    startScrollLeft: number
    moved: boolean
  } | null>(null)
  const suppressNextClickRef = useRef(false)
  const [isDragging, setIsDragging] = useState(false)
  const labelFor = (tab: BrowserTab): string =>
    tab.title || (isStartPageUrl(tab.url) ? 'New Tab' : tab.url) || 'New Tab'

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    if (event.target instanceof Element && event.target.closest('button')) return
    // If a previous drag ended without Chromium emitting its compatibility
    // click, a new press is unambiguously a fresh interaction.
    suppressNextClickRef.current = false
    if (event.currentTarget.scrollWidth <= event.currentTarget.clientWidth) return
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startScrollLeft: event.currentTarget.scrollLeft,
      moved: false,
    }
    try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* unsupported */ }
  }

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const deltaX = event.clientX - drag.startX
    const deltaY = event.clientY - drag.startY
    if (!drag.moved) {
      if (Math.abs(deltaX) < 4 || Math.abs(deltaX) <= Math.abs(deltaY)) return
      drag.moved = true
      setIsDragging(true)
    }
    event.preventDefault()
    event.currentTarget.scrollLeft = drag.startScrollLeft - deltaX
  }

  const finishPointerDrag = (
    event: ReactPointerEvent<HTMLDivElement>,
    suppressClick = true,
  ): void => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    suppressNextClickRef.current = suppressClick && drag.moved
    dragRef.current = null
    setIsDragging(false)
    try { event.currentTarget.releasePointerCapture(event.pointerId) } catch { /* unsupported */ }
  }

  return (
    <div
      className={`flex h-11 shrink-0 touch-pan-y items-center gap-1 overflow-x-auto bg-surface-1 px-3 no-scrollbar ${
        isDragging ? 'cursor-grabbing select-none' : ''
      }`}
      aria-label="Browser tabs"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={finishPointerDrag}
      onPointerCancel={(event) => finishPointerDrag(event, false)}
      onClickCapture={(event) => {
        if (!suppressNextClickRef.current) return
        suppressNextClickRef.current = false
        event.preventDefault()
        event.stopPropagation()
      }}
    >
      {/* Pinned — favicon-only chips */}
      {pinned.map((tab) => {
        const isActive = tab.id === activeTabId
        return (
          <Tooltip key={tab.id} label={`${labelFor(tab)} · right-click to unpin`}>
            <button
              onClick={() => onSelect(tab.id)}
              onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); onClose(tab.id) } }}
              onContextMenu={(e) => { e.preventDefault(); onTogglePin(tab.id) }}
              className={`flex h-7 w-8 shrink-0 items-center justify-center rounded-xl transition-colors ${
                isActive ? 'bg-surface-4 text-primary' : 'text-muted hover:bg-hover'
              }`}
              aria-label={labelFor(tab)}
            >
              <BrowserFavicon src={tab.favicon ?? faviconForUrl(tab.url)} size={15} />
            </button>
          </Tooltip>
        )
      })}

      {/* Divider between pinned chips and the regular tabs */}
      {pinned.length > 0 && unpinned.length > 0 && (
        <div className="h-4 w-px shrink-0 bg-subtle" />
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
            title={`${labelFor(tab)} · right-click to pin`}
            className={`group flex h-7 min-w-[112px] max-w-[220px] cursor-pointer select-none items-center gap-2 rounded-xl pl-2.5 pr-1.5 transition-colors ${
              isActive ? 'bg-surface-4 text-primary' : 'text-muted hover:text-secondary hover:bg-hover'
            }`}
          >
            <BrowserFavicon src={tab.favicon ?? faviconForUrl(tab.url)} size={15} />
            <span className="min-w-0 flex-1 truncate text-sm">{labelFor(tab)}</span>
            <button
              onClick={(e) => { e.stopPropagation(); onClose(tab.id) }}
              className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-muted transition-opacity hover:bg-hover hover:text-primary ${
                isActive ? 'opacity-70' : 'opacity-0 group-hover:opacity-100'
              }`}
              aria-label="Close tab"
            >
              <X size={13} />
            </button>
          </div>
        )
      })}

      {/* New tab */}
      <Tooltip label="New tab">
        <button
          onClick={onNewTab}
          className="flex h-7 w-8 shrink-0 items-center justify-center rounded-xl text-muted transition-colors hover:bg-hover hover:text-secondary"
          aria-label="New tab"
        >
          <Plus size={16} />
        </button>
      </Tooltip>
    </div>
  )
}
