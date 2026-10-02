// Keyboard and link input of the terminal view: paste and copy chords, macOS
// line-editing chords, CSI u for modified special keys, and where a clicked
// URL opens.

import { isLoopbackUrl } from '@runtime/tunnel/contract'
import type { TerminalLinkOpenTarget } from '@services/terminal/contract'
import { resolveTerminalKeySequence } from '../keymap'
import { resolveTerminalLinkTarget } from '../links'

/** Ctrl+V / Ctrl+Shift+V off Mac keyboards. xterm has no binding for it and
 *  would send a literal ^V; skipping the key without preventDefault lets the
 *  browser fire its paste event into xterm, which pastes once (bracketed when
 *  the program asked). A Mac keeps Ctrl+V as "literal next". */
export function isTerminalPasteChord(event: KeyboardEvent, isMac: boolean): boolean {
  if (isMac) return false
  if (event.type !== 'keydown' || !event.ctrlKey || event.altKey || event.metaKey) return false
  return event.key === 'v' || event.key === 'V'
}

function isTerminalCopyChord(event: KeyboardEvent, terminal: { hasSelection(): boolean }, isMac: boolean): boolean {
  if (isMac) return false
  if (event.type !== 'keydown' || !event.ctrlKey || event.altKey || event.metaKey) return false
  if (event.key !== 'c' && event.key !== 'C') return false
  return terminal.hasSelection()
}

/** Special keys xterm does not tell apart with modifiers, sent as CSI u. */
const CSI_U_KEYS: Record<string, number> = {
  Enter: 13,
  Tab: 9,
  Backspace: 127,
  Escape: 27,
  Space: 32,
}

/** xterm's custom key handler. `send` writes bytes as keystrokes. Returning
 *  false makes xterm skip the key; preventDefault only when we sent bytes. */
export function makeTerminalKeyEventHandler(
  terminal: { hasSelection(): boolean },
  send: (data: string) => void,
  isMac: boolean,
): (event: KeyboardEvent) => boolean {
  return (event) => {
    if (event.type !== 'keydown') return true
    if (isTerminalPasteChord(event, isMac)) return false
    if (isTerminalCopyChord(event, terminal, isMac)) return false

    const seq = resolveTerminalKeySequence(event, isMac)
    if (seq !== null) {
      send(seq)
      event.preventDefault()
      return false
    }

    const keyCode = CSI_U_KEYS[event.key]
    if (keyCode === undefined) return true
    // 1 + (shift=1, alt=2, ctrl=4, meta=8)
    let mod = 1
    if (event.shiftKey) mod += 1
    if (event.altKey) mod += 2
    if (event.ctrlKey) mod += 4
    if (event.metaKey) mod += 8
    if (mod === 1) return true
    if (event.key === 'Tab' && mod === 2) return true // Shift+Tab is reverse tab
    if (event.metaKey) return true // Cmd combos are app shortcuts
    send(`\x1b[${keyCode};${mod}u`)
    event.preventDefault()
    return false
  }
}

export interface LinkOpenPorts {
  /** The `terminalLinkOpenTarget` client setting. */
  target(): TerminalLinkOpenTarget
  remember(target: 'canvas' | 'external'): void
  ask(url: string): Promise<'canvas' | 'external' | 'cancel'>
  openExternal(url: string): void
  /** Opens inside Cate, next to the terminal. */
  openInCate(url: string): void
}

/** Cmd/Ctrl+click opens a URL where the setting says (asking the first time
 *  and remembering the answer); adding Shift always opens it outside. A
 *  loopback URL names the runtime's machine (architecture D10), so it always
 *  opens inside Cate, with or without Shift, and is never asked about. */
export function createTerminalLinkHandler(ports: LinkOpenPorts, isMac: boolean): (event: MouseEvent, url: string) => void {
  const openPrimary = async (url: string) => {
    let target = ports.target()
    if (target === 'ask') {
      const choice = await ports.ask(url)
      if (choice === 'cancel') return
      ports.remember(choice)
      target = choice
    }
    if (target === 'canvas') ports.openInCate(url)
    else ports.openExternal(url)
  }
  return (event, url) => {
    const target = resolveTerminalLinkTarget(event, isMac)
    if (target !== 'ignore' && isLoopbackUrl(url)) {
      ports.openInCate(url)
      return
    }
    switch (target) {
      case 'panel':
        void openPrimary(url).catch(() => {})
        break
      case 'external':
        ports.openExternal(url)
        break
      case 'ignore':
        break
    }
  }
}
