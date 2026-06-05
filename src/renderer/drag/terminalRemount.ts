import type { PanelType } from '../../shared/types'

interface RegistryEntryLike {
  ptyId: string
  scrollback?: string
}

export interface TerminalRegistryLike {
  getEntry(panelId: string): RegistryEntryLike | undefined
  setPendingTransfer(panelId: string, ptyId: string, scrollback?: string): void
  captureScrollback(
    entry: { scrollback?: string },
    options?: { excludeCursorRow?: boolean },
  ): string | undefined
}

export function prepareTerminalRemount(
  panelId: string,
  panelType: PanelType,
  registry: TerminalRegistryLike,
): boolean {
  if (panelType !== 'terminal') return false
  const entry = registry.getEntry(panelId)
  if (!entry) return false
  // Exclude the cursor row: the receiving terminal re-sends the prompt on remount.
  const scrollback = registry.captureScrollback(entry, { excludeCursorRow: true })
  registry.setPendingTransfer(panelId, entry.ptyId, scrollback)
  return true
}
