import type { PanelType } from '../../shared/types'

interface TerminalBufferLike {
  baseY: number
  cursorY: number
  getLine(i: number): { translateToString(trim?: boolean): string } | undefined
}

interface RegistryEntryLike {
  ptyId: string
  scrollback?: string
  terminal?: { buffer: { active: TerminalBufferLike } }
}

export interface TerminalRegistryLike {
  getEntry(panelId: string): RegistryEntryLike | undefined
  setPendingTransfer(panelId: string, ptyId: string, scrollback?: string): void
}

function captureScrollback(entry: RegistryEntryLike): string | undefined {
  if (typeof entry.scrollback === 'string') return entry.scrollback
  const buffer = entry.terminal?.buffer.active
  if (!buffer) return undefined
  try {
    const lastRow = buffer.baseY + buffer.cursorY
    const lines: string[] = []
    for (let i = 0; i < lastRow; i++) {
      const line = buffer.getLine(i)
      if (line) lines.push(line.translateToString(true))
    }
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
    const content = lines.join('\n')
    return content || undefined
  } catch {
    return undefined
  }
}

export function prepareTerminalRemount(
  panelId: string,
  panelType: PanelType,
  registry: TerminalRegistryLike,
): boolean {
  if (panelType !== 'terminal') return false
  const entry = registry.getEntry(panelId)
  if (!entry) return false
  const scrollback = captureScrollback(entry)
  registry.setPendingTransfer(panelId, entry.ptyId, scrollback)
  return true
}
