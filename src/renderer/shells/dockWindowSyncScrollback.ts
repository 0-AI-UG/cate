import { terminalRegistry } from '../lib/terminal/terminalRegistry'
import { captureAndSaveScrollback } from '../lib/terminal/captureAndSaveScrollback'
import type { PanelState } from '../../shared/types'

/** Capture stable panel-keyed scrollback and cwd. Completion means every
 * scrollback write succeeded; callers may then publish and acknowledge state. */
export async function captureTerminalScrollbacks(
  panels: Record<string, PanelState>,
): Promise<Record<string, string>> {
  const terminalCwds: Record<string, string> = {}
  const savePromises: Array<Promise<void>> = []
  const cwdPromises: Array<Promise<void>> = []
  for (const panel of Object.values(panels)) {
    if (panel.type !== 'terminal') continue
    const entry = terminalRegistry.getEntry(panel.id)
    if (!entry) continue
    // Save scrollback under the stable panel id — same key the main window uses,
    // and the key restore reads. Reads the xterm buffer, so no ptyId needed; an
    // empty buffer (terminal still spawning) writes nothing and leaves any prior
    // `<panelId>.scrollback` untouched.
    const p = captureAndSaveScrollback(entry, panel.id)
    if (p) savePromises.push(p)
    // Best-effort cwd so a respawned terminal lands where it was. Needs the live
    // ptyId; skipped for a terminal that hasn't spawned yet (a later tick gets it).
    if (entry.ptyId) {
      cwdPromises.push(
        window.electronAPI
          .terminalGetCwd(entry.ptyId)
          .then((cwd) => {
            if (cwd) terminalCwds[panel.id] = cwd
          })
          .catch(() => {}),
      )
    }
  }
  await Promise.all([...cwdPromises, ...savePromises])
  return terminalCwds
}
