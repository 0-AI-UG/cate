import { describe, expect, it, vi } from 'vitest'
import {
  decodeOsc52ClipboardData,
  registerOsc52ClipboardHandler,
  type ClipboardWriter,
} from './terminalOsc52Clipboard'

function encodeBase64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64')
}

describe('decodeOsc52ClipboardData', () => {
  it('decodes UTF-8 clipboard payloads when OSC 52 targets the clipboard', () => {
    const encoded = encodeBase64('remote copy 한글')

    const decoded = decodeOsc52ClipboardData(`c;${encoded}`)

    expect(decoded).toBe('remote copy 한글')
  })

  it('decodes clipboard payloads when the selection target is empty', () => {
    const encoded = encodeBase64('empty target')

    const decoded = decodeOsc52ClipboardData(`;${encoded}`)

    expect(decoded).toBe('empty target')
  })

  it('ignores non-clipboard targets and paste requests', () => {
    expect(decodeOsc52ClipboardData(`p;${encodeBase64('primary')}`)).toBeNull()
    expect(decodeOsc52ClipboardData('c;?')).toBeNull()
  })
})

describe('registerOsc52ClipboardHandler', () => {
  it('writes decoded OSC 52 clipboard payloads to the provided clipboard writer', async () => {
    const handlers: Array<(data: string) => boolean | Promise<boolean>> = []
    const dispose = vi.fn()
    const registerOscHandler = vi.fn((ident: number, cb: (data: string) => boolean | Promise<boolean>) => {
      handlers.push(cb)
      return { dispose }
    })
    const writeText = vi.fn(async () => {})
    const clipboard: ClipboardWriter = { writeText }

    const cleanup = registerOsc52ClipboardHandler({ parser: { registerOscHandler } }, clipboard)
    const registeredHandler = handlers[0]
    if (!registeredHandler) throw new Error('OSC handler was not registered')
    const handled = await registeredHandler(`c;${encodeBase64('from tmux')}`)
    cleanup()

    expect(registerOscHandler).toHaveBeenCalledWith(52, expect.any(Function))
    expect(handled).toBe(true)
    expect(writeText).toHaveBeenCalledWith('from tmux')
    expect(dispose).toHaveBeenCalledTimes(1)
  })
})
