// OSC 52: a program in the terminal (tmux, vim, a remote shell) sets the
// system clipboard. The view registers this only on clients with `clipboard`,
// and writes through `clientUi().writeClipboard`.

import type { IDisposable, IParser } from '@xterm/xterm'

const OSC52_IDENT = 52

export interface ClipboardWriter {
  readonly writeText: (text: string) => Promise<void>
}

interface Osc52Terminal {
  readonly parser: Pick<IParser, 'registerOscHandler'>
}

function isExpectedDecodeFailure(error: unknown): boolean {
  if (error instanceof Error) return true
  return typeof DOMException !== 'undefined' && error instanceof DOMException
}

/** The clipboard text of an OSC 52 payload, or null for other selection
 *  targets, paste queries and garbage. */
export function decodeOsc52ClipboardData(data: string): string | null {
  const separator = data.indexOf(';')
  if (separator === -1) return null

  const selectionTarget = data.slice(0, separator)
  if (selectionTarget !== '' && !selectionTarget.includes('c')) return null

  const encoded = data.slice(separator + 1).trim()
  if (encoded === '?') return null

  try {
    const binary = atob(encoded)
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
    return new TextDecoder().decode(bytes)
  } catch (error: unknown) {
    if (isExpectedDecodeFailure(error)) return null
    throw error
  }
}

export function registerOsc52ClipboardHandler(
  terminal: Osc52Terminal,
  clipboard: ClipboardWriter,
  onError?: (error: unknown) => void,
): () => void {
  const registerOscHandler = terminal.parser?.registerOscHandler?.bind(terminal.parser)
  if (!registerOscHandler) return () => {}

  const disposable: IDisposable = registerOscHandler(OSC52_IDENT, (data) => {
    const text = decodeOsc52ClipboardData(data)
    if (text === null) return false
    return clipboard.writeText(text).then(
      () => true,
      (error: unknown) => {
        onError?.(error)
        return true
      },
    )
  })
  return () => disposable.dispose()
}
