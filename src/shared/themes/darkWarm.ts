import type { Theme } from '../theme'
import { THEME_SCHEMA_VERSION } from '../theme'

/** Dark Warm — the original CanvasIDE warm dark palette (default dark theme).
 *  `app` is empty: its values equal BASE_DARK. */
export const darkWarm: Theme = {
  version: THEME_SCHEMA_VERSION,
  id: 'dark-warm',
  name: 'Dark Warm',
  type: 'dark',
  builtIn: true,
  bootBackground: '#1f1e1c',
  app: {},
  terminal: {
    background: '#1f1e1c',
    foreground: '#D4D4D4',
    cursor: '#AEAFAD',
    selectionBackground: '#264F78',
    selectionForeground: '#D4D4D4',
    black: '#000000', red: '#CD3131', green: '#0DBC79', yellow: '#E5E510',
    blue: '#2472C8', magenta: '#BC3FBC', cyan: '#11A8CD', white: '#E5E5E5',
    brightBlack: '#666666', brightRed: '#F14C4C', brightGreen: '#23D18B', brightYellow: '#F5F543',
    brightBlue: '#3B8EEA', brightMagenta: '#D670D6', brightCyan: '#29B8DB', brightWhite: '#FFFFFF',
  },
  editor: {
    base: 'vs-dark',
    colors: {
      'editor.background': '#1f1e1c',
      'editorGutter.background': '#1f1e1c',
      'minimap.background': '#1f1e1c',
      'editor.lineHighlightBorder': '#00000000',
      'contrastBorder': '#00000000',
    },
    tokens: [],
  },
}
