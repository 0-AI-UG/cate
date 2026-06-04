// =============================================================================
// terminalLinks — where a clicked terminal link should open.
//
// Mirrors VS Code: the platform's primary modifier (Cmd on mac, Ctrl elsewhere)
// opens the link; adding Shift sends it to the external system browser instead
// of the in-app BrowserPanel. A plain click (no modifier) does nothing.
//
// Pure + dependency-free so it is trivially unit-testable; the WebLinksAddon
// handler in terminalRegistry calls this and routes the open accordingly.
// =============================================================================

export type TerminalLinkTarget = 'panel' | 'external' | 'ignore'

/**
 * Resolve a link click to an open target.
 *
 * - primary modifier (Cmd on mac, Ctrl on win/linux) → 'panel' (in-app browser)
 * - primary modifier + Shift → 'external' (system browser)
 * - otherwise → 'ignore' (plain click, or the non-primary modifier)
 */
export function resolveTerminalLinkTarget(
  e: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean },
  isMac: boolean,
): TerminalLinkTarget {
  const primary = isMac ? e.metaKey : e.ctrlKey
  if (!primary) return 'ignore'
  return e.shiftKey ? 'external' : 'panel'
}
