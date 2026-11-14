import type { Theme } from '../theme'
import { darkNeutral } from './darkNeutral'

/** One black work surface across native panels, with neutral raised chrome. */
export const black: Theme = {
  ...darkNeutral,
  id: 'black',
  name: 'Black',
  bootBackground: '#000000',
  app: {
    ...darkNeutral.app,
    'surface-0': '#000000',
    'surface-1': '#101010',
    'surface-2': '#1c1c1c',
    'surface-3': '#242424',
    'surface-4': '#2b2b2b',
    'surface-5': '#323232',
    'surface-6': '#3a3a3a',
    'titlebar-bg': '#0b0b0b',
    'canvas-bg': '#050505',
    'canvas-bg-alt': '#090909',
    'border-subtle': 'rgba(255, 255, 255, 0.10)',
    'border-strong': 'rgba(255, 255, 255, 0.20)',
    'text-primary': '#eeeeee',
    'text-secondary': '#a0a0a0',
    'text-muted': '#7a7a7a',
    'node-bg-active': '#000000',
    'surface-hover': 'rgba(255, 255, 255, 0.055)',
    'surface-hover-strong': 'rgba(255, 255, 255, 0.10)',
  },
  terminal: {
    ...darkNeutral.terminal,
    background: '#000000',
    foreground: '#dedede',
    brightBlack: '#858585',
  },
  editor: {
    ...darkNeutral.editor,
    colors: {
      ...darkNeutral.editor.colors,
      'editor.background': '#000000',
      'editor.foreground': '#dedede',
      'editorGutter.background': '#000000',
      'minimap.background': '#000000',
      'editor.lineHighlightBackground': '#101010',
      'editorLineNumber.foreground': '#777777',
    },
  },
}
