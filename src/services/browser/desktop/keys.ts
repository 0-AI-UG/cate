// Key specs an agent sends (`Enter`, `Meta+a`, `Shift+ArrowDown`) as the
// key events the page driver dispatches to its guest.

import type { KeyboardInputEvent } from 'electron'

// Named keys: Electron's key code, and the character the key types.
const NAMED_KEYS: Record<string, { keyCode: string; text?: string }> = {
  Enter: { keyCode: 'Enter', text: '\r' }, Tab: { keyCode: 'Tab' }, Escape: { keyCode: 'Escape' },
  Backspace: { keyCode: 'Backspace' }, Delete: { keyCode: 'Delete' }, Space: { keyCode: 'Space', text: ' ' },
  ArrowLeft: { keyCode: 'Left' }, ArrowUp: { keyCode: 'Up' }, ArrowRight: { keyCode: 'Right' }, ArrowDown: { keyCode: 'Down' },
  PageUp: { keyCode: 'PageUp' }, PageDown: { keyCode: 'PageDown' }, Home: { keyCode: 'Home' }, End: { keyCode: 'End' },
}

const ALIASES: Record<string, string> = { Return: 'Enter', Esc: 'Escape', ' ': 'Space', Up: 'ArrowUp', Down: 'ArrowDown', Left: 'ArrowLeft', Right: 'ArrowRight' }
const MODIFIER_ALIASES: Record<string, string> = { Ctrl: 'Control', Cmd: 'Meta', Command: 'Meta', Option: 'Alt' }

// What Shift types on a US-layout digit or punctuation key.
const US_SHIFTED: Record<string, string> = {
  '1': '!', '2': '@', '3': '#', '4': '$', '5': '%', '6': '^', '7': '&', '8': '*', '9': '(', '0': ')',
  '-': '_', '=': '+', '[': '{', ']': '}', '\\': '|', ';': ':', "'": '"', ',': '<', '.': '>', '/': '?', '`': '~',
}

// macOS runs these shortcuts as editing commands, not from key events, and a
// command of a key event needs its guest focused: the driver runs them in the
// page's focused field instead.
const MAC_EDITING_COMMANDS: Record<string, string> = {
  'Meta+a': 'selectAll', 'Meta+c': 'copy', 'Meta+x': 'cut', 'Meta+v': 'paste',
  'Meta+z': 'undo', 'Meta+Shift+z': 'redo', 'Meta+Backspace': 'deleteToBeginningOfLine',
  'Meta+ArrowLeft': 'moveToBeginningOfLine', 'Meta+ArrowRight': 'moveToEndOfLine',
}

/** What pressing a key spec does: scroll the page a screen (PageUp and
 *  PageDown alone), or key events plus the macOS editing command they run. */
export type KeyPress =
  | { scrollPage: 1 | -1 }
  | { events: KeyboardInputEvent[]; command?: string }

export function parseKey(spec: string, platform: string = process.platform): KeyPress {
  const parts = spec.replace(/^cmd\+/i, 'Meta+').split(/\+(?=.)/)
  const named = parts.pop() || ''
  const keyName = ALIASES[named] ?? named
  const modifierNames = parts.map(part => MODIFIER_ALIASES[part] ?? part)
  const unknown = modifierNames.find(part => !['Alt', 'Control', 'Meta', 'Shift'].includes(part))
  if (unknown) throw new Error(`unsupported-key-modifier:${unknown}`)
  const namedKey = NAMED_KEYS[keyName]
  if (!namedKey && keyName.length !== 1) throw new Error(`unsupported-key:${keyName}`)
  if ((keyName === 'PageDown' || keyName === 'PageUp') && parts.length === 0) return { scrollPage: keyName === 'PageDown' ? 1 : -1 }
  const shift = modifierNames.includes('Shift')
  const text = namedKey ? namedKey.text : shift ? US_SHIFTED[keyName] ?? keyName.toUpperCase() : keyName
  const keyCode = namedKey?.keyCode ?? keyName
  const modifiers = modifierNames.map(name => name.toLowerCase() as 'alt' | 'control' | 'meta' | 'shift')
  // A key with text types it (a char event); a shortcut does not.
  const typing = text !== undefined && modifierNames.every(name => name === 'Shift')
  const command = platform === 'darwin' ? MAC_EDITING_COMMANDS[[...modifierNames, keyName].join('+')] : undefined
  return {
    events: [
      { type: 'keyDown', keyCode, modifiers },
      ...(typing ? [{ type: 'char' as const, keyCode: text === '\r' ? 'Enter' : text, modifiers }] : []),
      { type: 'keyUp', keyCode, modifiers },
    ],
    ...(command ? { command } : {}),
  }
}
