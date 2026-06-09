import type { PanelType } from '../../shared/types'
import type { SerializeAddon } from '@xterm/addon-serialize'

interface RegistryEntryLike {
  ptyId: string
  scrollback?: string
  serializeAddon?: SerializeAddon | null
}

export interface TerminalRegistryLike {
  getEntry(panelId: string): RegistryEntryLike | undefined
  setPendingTransfer(panelId: string, ptyId: string, scrollback?: string): void
  serializeTerminalState(entry: { serializeAddon?: SerializeAddon | null }): string | undefined
}

export function prepareTerminalRemount(
  panelId: string,
  panelType: PanelType,
  registry: TerminalRegistryLike,
): boolean {
  if (panelType !== 'terminal') return false
  const entry = registry.getEntry(panelId)
  if (!entry) return false
  // Serialize the buffer (text + styling + cursor) so the rebuilt xterm restores
  // verbatim.
  const scrollback = registry.serializeTerminalState(entry)
  registry.setPendingTransfer(panelId, entry.ptyId, scrollback)
  return true
}
