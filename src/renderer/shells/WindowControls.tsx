// =============================================================================
// WindowControls — custom minimize / maximize / close buttons for the frameless
// window chrome on Windows & Linux. macOS uses native traffic lights, so this
// renders nothing there (the parent strips can mount it unconditionally).
//
// Buttons are flat and theme-driven (titlebar bg, --text-secondary, surface
// hover); the close button gets a destructive red hover, matching platform
// convention. Each button is a `no-drag` island inside the draggable titlebar.
// =============================================================================

import { useEffect, useState } from 'react'
import { Minus, Square, Copy, X } from '@phosphor-icons/react'

const IS_MAC = navigator.userAgent.includes('Mac')

const NO_DRAG: React.CSSProperties = { WebkitAppRegion: 'no-drag' } as React.CSSProperties

export default function WindowControls() {
  const [isMaximized, setIsMaximized] = useState<boolean>(
    () => window.electronAPI.isWindowMaximized?.() ?? false,
  )

  useEffect(() => {
    if (IS_MAC) return
    return window.electronAPI.onWindowMaximizeChange?.((value) => setIsMaximized(value))
  }, [])

  // Native chrome on macOS — render nothing.
  if (IS_MAC) return null

  return (
    <div className="flex items-center h-full shrink-0" style={NO_DRAG}>
      <button
        type="button"
        aria-label="Minimize"
        title="Minimize"
        className="h-full w-11 flex items-center justify-center text-secondary hover:bg-surface-hover hover:text-primary transition-colors"
        onClick={() => window.electronAPI.windowMinimize?.()}
      >
        <Minus size={15} weight="bold" />
      </button>
      <button
        type="button"
        aria-label={isMaximized ? 'Restore' : 'Maximize'}
        title={isMaximized ? 'Restore' : 'Maximize'}
        className="h-full w-11 flex items-center justify-center text-secondary hover:bg-surface-hover hover:text-primary transition-colors"
        onClick={() => window.electronAPI.windowToggleMaximize?.()}
      >
        {isMaximized ? <Copy size={13} weight="bold" /> : <Square size={12} weight="bold" />}
      </button>
      <button
        type="button"
        aria-label="Close"
        title="Close"
        className="h-full w-11 flex items-center justify-center text-secondary hover:bg-red-600 hover:text-white transition-colors"
        onClick={() => window.electronAPI.windowClose?.()}
      >
        <X size={15} weight="bold" />
      </button>
    </div>
  )
}
