// =============================================================================
// WindowChrome — the shared overlay chrome every Cate window renders: the Cmd+K
// command palette, the settings window, the skills dialog, and
// the cross-window drag overlay.
//
// Mounted by each shell INSIDE its store providers (so the palette's
// useCanvasStoreApi resolves the right canvas). Pairs with useWindowRuntime,
// which installs the matching behavior (shortcuts open the palette, Cmd+, /
// provider sign-in open settings). Replaces the per-shell copies that previously
// drifted between the main window and the detached shells.
//
// The skills dialog lives here (not just in MainApp) because the
// command palette — which every window has — can open it; without it mounted
// here, that action in a detached window would flip the flag and show nothing.
// It self-gates on its uiStore `show` flag, so it is inert until opened.
// =============================================================================

import React from 'react'
import { useUIStore } from '../stores/uiStore'
import { CommandPalette } from '../ui/CommandPalette'
import { SettingsWindow } from '../settings/SettingsWindow'
import { SkillsDialog } from '../dialogs/SkillsDialog'
import { DragOverlay } from '../drag'

export default function WindowChrome(): React.JSX.Element {
  const showCommandPalette = useUIStore((s) => s.showCommandPalette)
  const showSettings = useUIStore((s) => s.showSettings)
  const settingsInitialTab = useUIStore((s) => s.settingsInitialTab)
  const closeSettings = useUIStore((s) => s.closeSettings)

  return (
    <>
      {showCommandPalette && <CommandPalette />}
      {showSettings && (
        <SettingsWindow
          isOpen={showSettings}
          onClose={closeSettings}
          initialTab={settingsInitialTab ?? undefined}
        />
      )}
      <SkillsDialog />
      <DragOverlay />
    </>
  )
}
