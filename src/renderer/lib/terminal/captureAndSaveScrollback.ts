// =============================================================================
// captureAndSaveScrollback — the shared "snapshot a terminal's buffer and
// persist it" step used by session capture and both detached-window shells.
//
// The buffer is serialized (text + styling + cursor) so a restored terminal
// keeps its exact look; replayTerminalLog writes the saved string verbatim into
// the fresh xterm on the next launch. When the buffer has no content there is
// nothing to save and the call is skipped.
//
// Callers use the restore-stable panel id and await publication. Failures must
// propagate to the session durability gate.
// =============================================================================

import { terminalRegistry } from './terminalRegistry'

export function captureAndSaveScrollback(
  entry: Parameters<typeof terminalRegistry.serializeTerminalState>[0],
  saveKey: string,
): Promise<void> | undefined {
  const content = terminalRegistry.serializeTerminalState(entry)
  if (!content) return undefined
  return window.electronAPI.terminalScrollbackSave(saveKey, content)
}
