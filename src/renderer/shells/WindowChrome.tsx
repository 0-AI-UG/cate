// Window-local palette and drag feedback; application pages are main-only.
import React, { useContext } from 'react'
import { WindowTypeContext } from '../stores/WindowTypeContext'
import { useUIStore } from '../stores/uiStore'
import { CommandPalette } from '../ui/CommandPalette'
import { SettingsWindow } from '../settings/SettingsWindow'
import { SkillsDialog } from '../dialogs/SkillsDialog'
import { DragOverlay } from '../drag'

export default function WindowChrome(): React.JSX.Element {
  const mainWindow = useContext(WindowTypeContext) === 'main'
  const showCommandPalette = useUIStore((s) => s.showCommandPalette)
  const showSettings = useUIStore((s) => s.showSettings)
  const settingsInitialTab = useUIStore((s) => s.settingsInitialTab)
  const closeSettings = useUIStore((s) => s.closeSettings)

  return (
    <>
      {showCommandPalette && <CommandPalette />}
      {mainWindow && showSettings && (
        <SettingsWindow
          isOpen={showSettings}
          onClose={closeSettings}
          initialTab={settingsInitialTab ?? undefined}
        />
      )}
      {mainWindow && <SkillsDialog />}
      <DragOverlay />
    </>
  )
}
