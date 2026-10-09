import { defineSettings, setting } from '@kernel/settings/contract/define'

/** How this device shows diffs in every review panel. */
export const reviewSettings = defineSettings({
  scope: 'client',
  keys: {
    reviewSplitDiff: setting(false),
    reviewWordDiff: setting(true),
    reviewWrapLines: setting(false),
    /** Load whole files instead of hunks with context. */
    reviewFullFiles: setting(false),
    reviewImagePreviews: setting(true),
  },
})
