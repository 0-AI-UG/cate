import type { Theme } from '../theme'
import { THEME_SCHEMA_VERSION } from '../theme'

/** Light Subtle — warm Bone/Khaki/Taupe palette (default light theme).
 *  `app` is empty: its values equal BASE_LIGHT. */
export const lightSubtle: Theme = {
  version: THEME_SCHEMA_VERSION,
  id: 'light-subtle',
  name: 'Light Subtle',
  type: 'light',
  builtIn: true,
  bootBackground: '#f4f3f0',
  app: {},
  terminal: {
    background: '#ddd5ca',
    foreground: '#38322b',
    cursor: '#3c7ef0',
    cursorAccent: '#ddd5ca',
    selectionBackground: '#b1a696',
    selectionForeground: '#38322b',
    black: '#38322b', red: '#c04030', green: '#4a8f3a', yellow: '#b58900',
    blue: '#3c7ef0', magenta: '#a04a7a', cyan: '#5e747f', white: '#8a8274',
    brightBlack: '#5e747f', brightRed: '#cb4b16', brightGreen: '#5fa34a', brightYellow: '#c89a1f',
    brightBlue: '#5e93f4', brightMagenta: '#b85a8a', brightCyan: '#7a8f99', brightWhite: '#38322b',
  },
  editor: {
    base: 'vs',
    colors: {
      'editor.background': '#ddd5ca',
      'editorGutter.background': '#ddd5ca',
      'minimap.background': '#ddd5ca',
      'editor.foreground': '#38322b',
      'editorLineNumber.foreground': '#8a8274',
      'editorLineNumber.activeForeground': '#38322b',
      'editor.lineHighlightBackground': '#e5dfd6',
      'editor.lineHighlightBorder': '#00000000',
      'editor.selectionBackground': '#c8bfb0',
      'editorCursor.foreground': '#3c7ef0',
      'contrastBorder': '#00000000',
    },
    tokens: [],
  },
}
