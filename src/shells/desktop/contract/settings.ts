import { defineSettings, everyItem, numberIn, oneOf, setting } from '@kernel/settings/contract/define'
import { isSshMachine, type SshMachine } from '@runtime/daemon/contract/ssh'

export const desktopSettings = defineSettings({
  scope: 'client',
  keys: {
    warnBeforeQuit: setting(false),
    /** Offer GitHub pre-releases to the auto-updater. */
    betaUpdatesEnabled: setting(false),
    /** Works around GPU glyph-atlas corruption; applies after restart. */
    disableGpuRasterization: setting(false),
  },
})

// The desktop UI's own settings.

export type CanvasGridStyle = 'dots' | 'lines' | 'none'

export const canvasSettings = defineSettings({
  scope: 'client',
  keys: {
    zoomSpeed: setting(1.0, numberIn(0.5, 3)),
    canvasGridStyle: setting<CanvasGridStyle>('lines', oneOf('dots', 'lines', 'none')),
    /** Absolute path of the wallpaper image; empty for none. */
    canvasBackgroundImagePath: setting(''),
    canvasBackgroundImageOpacity: setting(0.4, numberIn(0, 1)),
    showWorktreeTerritory: setting(true),
    /** Hold Alt during a drag or resize to bypass. */
    snapToGrid: setting(false),
    /** Offer numbered spots for a new panel instead of placing it at once. */
    placementPicker: setting(true),
    autoFocusLargestVisibleNode: setting(false),
  },
})

export const sidebarSettings = defineSettings({
  scope: 'client',
  keys: {
    sidebarTintOpacity: setting(1.0, numberIn(0.3, 1)),
    showSkillsInWorkspaceOverview: setting(true),
  },
})

export const notificationSettings = defineSettings({
  scope: 'client',
  keys: {
    notificationsEnabled: setting(true),
    notifyOnlyWhenUnfocused: setting(true),
  },
})

/** Machines this device sets workspaces up on over SSH ("Remote machines"). */
export const remoteMachineSettings = defineSettings({
  scope: 'client',
  keys: {
    sshMachines: setting<SshMachine[]>([], everyItem(isSshMachine)),
  },
})
