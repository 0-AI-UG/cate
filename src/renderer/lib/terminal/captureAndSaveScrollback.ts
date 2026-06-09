// =============================================================================
// captureAndSaveScrollback — the shared "snapshot a terminal's buffer and
// persist it" step used by session capture and both detached-window shells.
//
// The buffer is serialized (text + styling + cursor) so a restored terminal
// keeps its exact look; replayTerminalLog writes the saved string verbatim into
// the fresh xterm on the next launch. When the buffer has no content there is
// nothing to save and the call is skipped.
//
// The save KEY differs by caller — session capture keys scrollback by the
// restore-stable panel id, while the detached-window shells key by the live
// ptyId — so the key is a parameter. The save promise is returned so callers
// can either await it (session capture batches them) or fire-and-forget (the
// shells); the rejection is already swallowed.
// =============================================================================

import { terminalRegistry } from './terminalRegistry'

export function captureAndSaveScrollback(
  entry: Parameters<typeof terminalRegistry.serializeTerminalState>[0],
  saveKey: string,
): Promise<void> | undefined {
  const content = terminalRegistry.serializeTerminalState(entry)
  if (!content) return undefined
  return window.electronAPI.terminalScrollbackSave(saveKey, content).catch(() => {})
}
