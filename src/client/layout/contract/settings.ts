import { defineSettings, numberIn, oneOf, setting } from '@kernel/settings/contract/define'

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
