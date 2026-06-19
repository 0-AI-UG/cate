import type { IDisposable, IParser } from '@xterm/xterm'
import log from '../logger'

const OSC52_IDENT = 52

export interface ClipboardWriter {
  readonly writeText: (text: string) => Promise<void>
}

export interface Osc52Terminal {
  readonly parser: Pick<IParser, 'registerOscHandler'>
}

function browserClipboardWriter(): ClipboardWriter | null {
  if (typeof window === 'undefined') return null
  return { writeText: (text: string) => window.electronAPI.terminalClipboardWrite(text) }
}

function isExpectedDecodeFailure(error: unknown): boolean {
  if (error instanceof Error) return true
  if (typeof DOMException !== 'undefined' && error instanceof DOMException) return true
  return false
}

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

function reportClipboardWriteFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  log.warn('[terminal] OSC 52 clipboard write failed:', message)
  return true
}

export function registerOsc52ClipboardHandler(
  terminal: Osc52Terminal,
  clipboard?: ClipboardWriter,
): () => void {
  const registerOscHandler = terminal.parser?.registerOscHandler?.bind(terminal.parser)
  if (!registerOscHandler) return () => {}

  const disposable: IDisposable = registerOscHandler(OSC52_IDENT, (data) => {
    const text = decodeOsc52ClipboardData(data)
    if (text === null) return false

    const writer = clipboard ?? browserClipboardWriter()
    if (!writer) return false

    return writer.writeText(text).then(
      () => true,
      (error: unknown) => reportClipboardWriteFailure(error),
    )
  })
  return () => disposable.dispose()
}
