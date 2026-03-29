// =============================================================================
// ContextMenu — Reusable context menu with submenu support.
// Renders at a fixed screen position via React portal, adjusts to avoid
// going off-screen, and closes on outside click or Escape.
// =============================================================================

import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface ContextMenuItem {
  label: string
  onClick: () => void
  danger?: boolean
  disabled?: boolean
  separator?: boolean
  submenu?: ContextMenuItem[]
  /** Render a small icon/swatch before the label */
  icon?: React.ReactNode
}

export interface ContextMenuProps {
  x: number
  y: number
  items: ContextMenuItem[]
  onClose: () => void
}

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const MENU_WIDTH = 200
const ITEM_HEIGHT = 32
const SEPARATOR_HEIGHT = 9 // py-1 top + 1px line + py-1 bottom
const PADDING_Y = 4 // py-1 on the container

function estimateMenuHeight(items: ContextMenuItem[]): number {
  return (
    PADDING_Y * 2 +
    items.reduce(
      (sum, item) => sum + (item.separator ? SEPARATOR_HEIGHT : ITEM_HEIGHT),
      0,
    )
  )
}

// -----------------------------------------------------------------------------
// Sub-menu panel
// -----------------------------------------------------------------------------

interface SubmenuPanelProps {
  items: ContextMenuItem[]
  parentRect: DOMRect
  onClose: () => void
}

const SubmenuPanel: React.FC<SubmenuPanelProps> = ({
  items,
  parentRect,
  onClose,
}) => {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x: parentRect.right, y: parentRect.top })

  useLayoutEffect(() => {
    if (!ref.current) return
    const vw = window.innerWidth
    const vh = window.innerHeight
    const menuH = estimateMenuHeight(items)
    let x = parentRect.right + 2
    let y = parentRect.top

    if (x + MENU_WIDTH > vw) {
      x = parentRect.left - MENU_WIDTH - 2
    }
    if (y + menuH > vh) {
      y = Math.max(4, vh - menuH - 4)
    }
    setPos({ x, y })
  }, [parentRect, items])

  return (
    <div
      ref={ref}
      className="fixed py-1 bg-[#1e1e22] border border-[#3a3a44] rounded-lg shadow-2xl"
      style={{ left: pos.x, top: pos.y, width: MENU_WIDTH, zIndex: 10000 }}
    >
      <MenuItemList items={items} onClose={onClose} />
    </div>
  )
}

// -----------------------------------------------------------------------------
// Single menu item row
// -----------------------------------------------------------------------------

interface MenuItemRowProps {
  item: ContextMenuItem
  onClose: () => void
}

const MenuItemRow: React.FC<MenuItemRowProps> = ({ item, onClose }) => {
  const [submenuOpen, setSubmenuOpen] = useState(false)
  const rowRef = useRef<HTMLDivElement>(null)
  const [rowRect, setRowRect] = useState<DOMRect | null>(null)

  const handleMouseEnter = useCallback(() => {
    if (item.submenu && item.submenu.length > 0) {
      if (rowRef.current) {
        setRowRect(rowRef.current.getBoundingClientRect())
      }
      setSubmenuOpen(true)
    }
  }, [item.submenu])

  const handleMouseLeave = useCallback(() => {
    setSubmenuOpen(false)
  }, [])

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      if (item.disabled) return
      if (item.submenu && item.submenu.length > 0) return
      e.stopPropagation()
      item.onClick()
      onClose()
    },
    [item, onClose],
  )

  const labelColor = item.danger
    ? 'text-red-400'
    : item.disabled
      ? 'text-white/25'
      : 'text-white/85'

  return (
    <div
      ref={rowRef}
      className={`relative flex items-center px-3 rounded-md mx-1 select-none transition-colors ${
        item.disabled
          ? 'cursor-default'
          : 'cursor-pointer hover:bg-white/[0.08] active:bg-white/[0.12]'
      }`}
      style={{ height: ITEM_HEIGHT }}
      onClick={handleClick}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {/* Icon */}
      {item.icon && <span className="flex-shrink-0 mr-2">{item.icon}</span>}

      {/* Label */}
      <span className={`text-sm flex-1 truncate ${labelColor}`}>
        {item.label}
      </span>

      {/* Chevron for submenu */}
      {item.submenu && item.submenu.length > 0 && (
        <span className="text-white/40 text-xs flex-shrink-0">›</span>
      )}

      {/* Submenu portal */}
      {submenuOpen && item.submenu && item.submenu.length > 0 && rowRect &&
        createPortal(
          <SubmenuPanel
            items={item.submenu}
            parentRect={rowRect}
            onClose={onClose}
          />,
          document.body,
        )}
    </div>
  )
}

// -----------------------------------------------------------------------------
// Item list renderer (shared by root and submenu)
// -----------------------------------------------------------------------------

interface MenuItemListProps {
  items: ContextMenuItem[]
  onClose: () => void
}

const MenuItemList: React.FC<MenuItemListProps> = ({ items, onClose }) => {
  return (
    <>
      {items.map((item, index) => {
        if (item.separator) {
          return (
            <div
              key={index}
              className="my-1 border-t border-[#333340]"
            />
          )
        }
        return <MenuItemRow key={index} item={item} onClose={onClose} />
      })}
    </>
  )
}

// -----------------------------------------------------------------------------
// Root ContextMenu component
// -----------------------------------------------------------------------------

const ContextMenu: React.FC<ContextMenuProps> = ({ x, y, items, onClose }) => {
  const menuRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x, y })

  // Adjust position to keep menu on-screen
  useLayoutEffect(() => {
    const vw = window.innerWidth
    const vh = window.innerHeight
    const menuH = estimateMenuHeight(items)
    let adjX = x
    let adjY = y

    if (adjX + MENU_WIDTH > vw) {
      adjX = Math.max(4, vw - MENU_WIDTH - 4)
    }
    if (adjY + menuH > vh) {
      adjY = Math.max(4, vh - menuH - 4)
    }
    setPos({ x: adjX, y: adjY })
  }, [x, y, items])

  // Close on Escape
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('keydown', handleKey, { capture: true })
    return () =>
      document.removeEventListener('keydown', handleKey, { capture: true })
  }, [onClose])

  // Close on click outside
  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose()
      }
    },
    [onClose],
  )

  return createPortal(
    // Full-screen transparent capture layer
    <div
      className="fixed inset-0"
      style={{ zIndex: 9999 }}
      onMouseDown={handleBackdropClick}
      onContextMenu={(e) => {
        e.preventDefault()
        onClose()
      }}
    >
      {/* Menu panel */}
      <div
        ref={menuRef}
        className="absolute py-1 bg-[#1e1e22] border border-[#3a3a44] rounded-lg shadow-2xl"
        style={{ left: pos.x, top: pos.y, width: MENU_WIDTH }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <MenuItemList items={items} onClose={onClose} />
      </div>
    </div>,
    document.body,
  )
}

export default ContextMenu
