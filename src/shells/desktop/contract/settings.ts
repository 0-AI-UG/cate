import { defineSettings, setting } from '@kernel/settings/contract/define'

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
