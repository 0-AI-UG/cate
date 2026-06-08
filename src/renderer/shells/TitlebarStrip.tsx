// =============================================================================
// TitlebarStrip — themed drag region rendered at the top of the main window.
//
// macOS (titleBarStyle: 'hiddenInset'): reserves space for the native traffic
// lights and provides a themed drag region. The native bar can't be tinted to a
// theme color, only dark/light, so we always use hidden-inset + this strip. The
// application menu is the global system menu bar, so nothing is drawn here.
//
// Windows/Linux (frame: false): the window is fully frameless, so this strip is
// the entire title bar. Because frame:false also removes the native in-window
// menu bar, we draw the application menu's top-level labels here (MenuBar) and
// pop the matching native submenus on click — keeping main/menu.ts as the single
// source of truth. Custom WindowControls (minimize/maximize/close) sit on the
// right, with double-click-to-maximize on the empty drag region between.
//
// In native fullscreen the OS hides its chrome, so the strip would otherwise be
// a dead zone at the top — subscribe to fullscreen state and collapse while it's
// active (on every platform).
// =============================================================================

import { useEffect, useState } from 'react'
import WindowControls from './WindowControls'

const IS_MAC = navigator.userAgent.includes('Mac')

// Drawn application menu bar for the frameless Windows/Linux title bar. Reads the
// top-level labels from main and pops the real native submenu under each label,
// so accelerators, native roles, and dynamic items (layouts, open windows) all
// keep working without re-implementing the menu in the renderer.
function MenuBar(): React.ReactElement | null {
  const [labels, setLabels] = useState<string[]>([])

  useEffect(() => {
    let cancelled = false
    window.electronAPI.getAppMenuBarItems?.().then((items) => {
      if (!cancelled) setLabels(items ?? [])
    })
    return () => {
      cancelled = true
    }
  }, [])

  if (labels.length === 0) return null

  return (
    <div className="flex items-stretch h-full" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
      {labels.map((label, index) => (
        <button
          key={`${index}-${label}`}
          type="button"
          className="px-2.5 h-full flex items-center text-xs text-secondary hover:bg-surface-hover hover:text-primary transition-colors whitespace-nowrap"
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect()
            window.electronAPI.popupAppMenu?.(index, rect.left, rect.bottom)
          }}
        >
          {label}
        </button>
      ))}
    </div>
  )
}

export default function TitlebarStrip() {
  const [isFullscreen, setIsFullscreen] = useState<boolean>(
    () => window.electronAPI.isMainWindowFullscreen?.() ?? false,
  )

  useEffect(() => {
    return window.electronAPI.onFullscreenChange?.((value) => setIsFullscreen(value))
  }, [])

  if (isFullscreen) return null

  // macOS: empty strip, padded for the native traffic lights.
  if (IS_MAC) {
    return (
      <div
        className="titlebar-drag shrink-0 bg-titlebar-bg select-none"
        style={{ paddingLeft: 80, height: 28 }}
      />
    )
  }

  // Windows/Linux: full title bar — menu bar on the left, draggable spacer in the
  // middle (double-click to maximize), custom window controls on the right.
  return (
    <div
      className="titlebar-drag shrink-0 bg-titlebar-bg select-none flex items-stretch"
      style={{ height: 28 }}
    >
      <MenuBar />
      <div
        className="flex-1 min-w-0"
        onDoubleClick={() => window.electronAPI.windowToggleMaximize?.()}
      />
      <WindowControls />
    </div>
  )
}
