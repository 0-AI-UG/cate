// Keyboard conventions follow the keyboard in front of the person: Cmd on a
// Mac keyboard, Ctrl elsewhere.

export function isMacKeyboard(): boolean {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent)
}
