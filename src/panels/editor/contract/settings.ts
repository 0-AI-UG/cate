import { defineSettings, numberIn, oneOf, setting } from '@kernel/settings/contract/define'

export type FilesTreeOnOpen = 'off' | 'left' | 'right'
export type FilesTreeOpenFileIn = 'panel' | 'beside'

export const editorSettings = defineSettings({
  scope: 'client',
  keys: {
    editorFontSize: setting(12, numberIn(8, 32, { integer: true })),
    /** CSS font-family; empty uses the built-in monospace stack. */
    editorFontFamily: setting(''),
    /** Docks a tree-only Files panel at this side of the main window when a
     *  workspace opens without one. */
    filesTreeOnOpen: setting<FilesTreeOnOpen>('off', oneOf('off', 'left', 'right')),
    /** Where a file clicked in a tree-only Files panel opens: in that panel,
     *  which then shows the editor, or in a panel beside it. */
    filesTreeOpenFileIn: setting<FilesTreeOpenFileIn>('panel', oneOf('panel', 'beside')),
  },
})
