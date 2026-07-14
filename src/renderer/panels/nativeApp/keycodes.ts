// =============================================================================
// Maps a browser KeyboardEvent.code (physical key, layout-independent) to the
// macOS virtual key code the sidecar feeds to CGEvent. Using the PHYSICAL key
// means the app's own keyboard-layout handling turns it back into the right
// character, so both text entry and shortcuts (⌘C, arrows, …) reproduce
// correctly regardless of the user's layout.
// =============================================================================

export const MAC_KEYCODES: Record<string, number> = {
  KeyA: 0, KeyS: 1, KeyD: 2, KeyF: 3, KeyH: 4, KeyG: 5, KeyZ: 6, KeyX: 7,
  KeyC: 8, KeyV: 9, KeyB: 11, KeyQ: 12, KeyW: 13, KeyE: 14, KeyR: 15,
  KeyY: 16, KeyT: 17, Digit1: 18, Digit2: 19, Digit3: 20, Digit4: 21,
  Digit6: 22, Digit5: 23, Equal: 24, Digit9: 25, Digit7: 26, Minus: 27,
  Digit8: 28, Digit0: 29, BracketRight: 30, KeyO: 31, KeyU: 32,
  BracketLeft: 33, KeyI: 34, KeyP: 35, Enter: 36, KeyL: 37, KeyJ: 38,
  Quote: 39, KeyK: 40, Semicolon: 41, Backslash: 42, Comma: 43, Slash: 44,
  KeyN: 45, KeyM: 46, Period: 47, Tab: 48, Space: 49, Backquote: 50,
  Backspace: 51, Escape: 53, ForwardDelete: 117, Delete: 51,
  Home: 115, End: 119, PageUp: 116, PageDown: 121,
  ArrowLeft: 123, ArrowRight: 124, ArrowDown: 125, ArrowUp: 126,
  Numpad0: 82, Numpad1: 83, Numpad2: 84, Numpad3: 85, Numpad4: 86,
  Numpad5: 87, Numpad6: 88, Numpad7: 89, Numpad8: 91, Numpad9: 92,
  NumpadEnter: 76, NumpadDecimal: 65, NumpadAdd: 69, NumpadSubtract: 78,
  NumpadMultiply: 67, NumpadDivide: 75,
  F1: 122, F2: 120, F3: 99, F4: 118, F5: 96, F6: 97, F7: 98, F8: 100,
  F9: 101, F10: 109, F11: 103, F12: 111,
}

/** macOS virtual key code for a KeyboardEvent.code, or undefined if unmapped. */
export function macKeyCode(code: string): number | undefined {
  return MAC_KEYCODES[code]
}
