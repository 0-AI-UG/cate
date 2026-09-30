import { defineSettings, numberIn, oneOf, setting } from '@kernel/settings/contract/define'

export type TerminalLinkOpenTarget = 'ask' | 'canvas' | 'external'

export const terminalClientSettings = defineSettings({
  scope: 'client',
  keys: {
    terminalFontFamily: setting(''),
    /** 0 follows the editor font size. */
    terminalFontSize: setting(0, numberIn(0, 32, { integer: true })),
    terminalScrollSpeed: setting(1.0, numberIn(0.25, 3)),
    /** Minimum WCAG contrast ratio; 1 uses theme colors exactly. */
    terminalContrast: setting(4.5, numberIn(1, 21)),
    /** Off by default: each blink wakes the compositor. */
    terminalCursorBlink: setting(false),
    terminalOptionIsMeta: setting(true),
    /** Cmd/Ctrl+Shift+click always opens externally. */
    terminalLinkOpenTarget: setting<TerminalLinkOpenTarget>('ask', oneOf('ask', 'canvas', 'external')),
  },
})

export const terminalSettings = defineSettings({
  scope: 'workspace',
  keys: {
    /** Empty resolves from $SHELL and the platform at spawn time. */
    defaultShellPath: setting(''),
    /** Lines kept by the headless terminal. */
    terminalScrollback: setting(2000, numberIn(100, 10_000, { integer: true })),
    /** SIGSTOP terminals that are offscreen and silent for 2 minutes (POSIX). */
    autoSuspendIdleTerminals: setting(true),
  },
})
