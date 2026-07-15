// =============================================================================
// terminalInput — keyboard chord detection, the xterm custom key-event handler,
// and the WebLinksAddon click handler. Pure input/keymap concerns; no registry
// state.
// =============================================================================

import { useSettingsStore } from '../../stores/settingsStore'
import { resolveTerminalKeySequence } from './terminalKeymap'
import { openTerminalUrl } from './terminalUrlOpen'
import { resolveTerminalLinkTarget } from './terminalLinks'
import { IS_MAC } from '../platform'

// Route through the shared IS_MAC so the CATE_FAKE_PLATFORM dev override also
// flips terminal keymap/paste-chord behavior, keeping one platform source.
const isMacPlatform = IS_MAC

/**
 * True for the Windows/Linux paste chord (Ctrl+V or Ctrl+Shift+V). xterm.js has
 * no built-in Ctrl+V binding, so it would otherwise encode a literal ^V (0x16)
 * to the PTY. The caller returns false for this chord, which makes xterm skip
 * the key WITHOUT calling preventDefault — so the browser still fires its native
 * paste event into xterm's textarea and xterm performs the paste exactly once
 * (honouring bracketed-paste mode). macOS keeps Ctrl+V as the terminal "literal
 * next" key and pastes with Cmd+V instead.
 */
export function isTerminalPasteChord(event: KeyboardEvent, isMac = isMacPlatform): boolean {
  if (isMac) return false
  if (event.type !== 'keydown' || !event.ctrlKey || event.altKey || event.metaKey) return false
  return event.key === 'v' || event.key === 'V'
}

export function isTerminalCopyChord(
  event: KeyboardEvent,
  terminal: { hasSelection(): boolean },
  isMac = isMacPlatform,
): boolean {
  if (isMac) return false
  if (event.type !== 'keydown' || !event.ctrlKey || event.altKey || event.metaKey) return false
  if (event.key !== 'c' && event.key !== 'C') return false
  return terminal.hasSelection()
}

/**
 * Open a primary (non-Shift) clicked terminal link per the
 * `terminalLinkOpenTarget` setting: 'canvas' opens an in-app BrowserPanel,
 * 'external' opens the system browser, and 'ask' shows a native dialog the
 * first time — the choice is then remembered (written to the setting) and can
 * be changed later in Settings → Browser.
 */
async function openPrimaryTerminalLink(workspaceId: string, uri: string): Promise<void> {
  let target = useSettingsStore.getState().terminalLinkOpenTarget
  if (target === 'ask') {
    const choice = await window.electronAPI.promptTerminalLinkOpen(uri)
    if (choice === 'cancel') return
    useSettingsStore.getState().setSetting('terminalLinkOpenTarget', choice)
    target = choice
  }
  if (target === 'canvas') openTerminalUrl(workspaceId, uri)
  else window.electronAPI.openExternalUrl(uri)
}

/**
 * WebLinksAddon click handler shared by the fresh-spawn and reconnect paths.
 * Mirrors VS Code: Cmd/Ctrl+Click opens the URL (destination per the
 * `terminalLinkOpenTarget` setting), +Shift always opens it in the external
 * system browser, and a plain click is ignored.
 */
export function createTerminalLinkHandler(
  workspaceId: string,
): (event: MouseEvent, uri: string) => void {
  return (event: MouseEvent, uri: string): void => {
    switch (resolveTerminalLinkTarget(event, isMacPlatform)) {
      case 'panel':
        void openPrimaryTerminalLink(workspaceId, uri)
        break
      case 'external':
        window.electronAPI.openExternalUrl(uri)
        break
      case 'ignore':
        break
    }
  }
}

// ---------------------------------------------------------------------------
// xterm custom key-event handler
//
// One factory shared by getOrCreate() and reconnectTerminal() (previously two
// copies). It covers, in order: paste/copy chords, macOS line-editing chords
// (Cmd/Option + Backspace/Delete/Arrows → literal control bytes), and CSI-u
// encoding for modified special keys (Ctrl+Enter, Shift+Tab, …) so shells and
// TUIs can tell them apart. Returning false makes xterm skip the key; we only
// preventDefault when we've written bytes ourselves.
// ---------------------------------------------------------------------------

/** Special keys xterm doesn't translate to distinct escape sequences — encoded
 *  as CSI u (fixterms/kitty) so shells/TUIs can distinguish the combos. */
const CSI_U_KEYS: Record<string, number> = {
  Enter: 13,
  Tab: 9,
  Backspace: 127,
  Escape: 27,
  Space: 32,
}

export function makeTerminalKeyEventHandler(
  terminal: { hasSelection(): boolean },
  ptyId: string,
): (event: KeyboardEvent) => boolean {
  return (event: KeyboardEvent) => {
    if (event.type !== 'keydown') return true

    // Skip without preventDefault so the browser still fires the native paste
    // event into xterm's textarea (xterm then pastes exactly once).
    if (isTerminalPasteChord(event)) return false
    if (isTerminalCopyChord(event, terminal)) return false

    // macOS line-editing chords → literal bytes the shell's line editor reads,
    // matching VS Code / Cursor. Pure table lives in terminalKeymap.ts.
    const seq = resolveTerminalKeySequence(event, isMacPlatform)
    if (seq !== null) {
      window.electronAPI.terminalWrite(ptyId, seq)
      event.preventDefault()
      return false
    }

    const keyCode = CSI_U_KEYS[event.key]
    if (keyCode === undefined) return true // let xterm handle all other keys

    // Build modifier param: 1 + (shift=1, alt=2, ctrl=4, meta=8)
    let mod = 1
    if (event.shiftKey) mod += 1
    if (event.altKey) mod += 2
    if (event.ctrlKey) mod += 4
    if (event.metaKey) mod += 8

    if (mod === 1) return true // no modifier — let xterm handle normally
    if (event.key === 'Tab' && mod === 2) return true // Shift+Tab = reverse-tab
    // Remaining Cmd+key combos are app shortcuts — let them propagate.
    if (event.metaKey) return true

    window.electronAPI.terminalWrite(ptyId, `\x1b[${keyCode};${mod}u`)
    event.preventDefault()
    return false
  }
}
