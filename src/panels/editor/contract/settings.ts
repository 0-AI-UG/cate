import { defineSettings, numberIn, setting } from '@kernel/settings/contract/define'

export const editorSettings = defineSettings({
  scope: 'client',
  keys: {
    editorFontSize: setting(12, numberIn(8, 32, { integer: true })),
    /** CSS font-family; empty uses the built-in monospace stack. */
    editorFontFamily: setting(''),
  },
})
