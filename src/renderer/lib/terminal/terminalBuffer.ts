import type { Terminal } from '@xterm/xterm'

/** Read the active xterm buffer once, preserving scrollback and dropping only
 * trailing empty rows. Shared by the terminal API and mission supervision. */
export function readTerminalBuffer(terminal: Terminal): { alt: boolean; text: string } {
  const buffer = terminal.buffer.active
  const lines: string[] = []
  for (let index = 0; index < buffer.length; index++) {
    lines.push(buffer.getLine(index)?.translateToString(true) ?? '')
  }
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return { alt: buffer.type === 'alternate', text: lines.join('\n') }
}

export function terminalBufferTail(terminal: Terminal, maxChars = 4_000): string {
  return readTerminalBuffer(terminal).text.slice(-maxChars)
}
