// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { createTerminalLinkHandler, isTerminalPasteChord, makeTerminalKeyEventHandler, type LinkOpenPorts } from './input'

const key = (init: Partial<KeyboardEvent> & { key: string }) =>
  ({ type: 'keydown', metaKey: false, altKey: false, ctrlKey: false, shiftKey: false, preventDefault: vi.fn(), ...init }) as unknown as KeyboardEvent
const click = (shiftKey = false) => ({ metaKey: true, ctrlKey: false, shiftKey }) as MouseEvent

function ports(target: 'ask' | 'canvas' | 'external', answer: 'canvas' | 'external' | 'cancel' = 'cancel') {
  let current = target
  const p = {
    target: () => current,
    remember: vi.fn((next: 'canvas' | 'external') => { current = next }),
    ask: vi.fn(async () => answer),
    openExternal: vi.fn(),
    openInCate: vi.fn(),
  } satisfies LinkOpenPorts
  return p
}

describe('link handler', () => {
  it('asks where to open a link and remembers the choice', async () => {
    const p = ports('ask', 'canvas')
    createTerminalLinkHandler(p, true)(click(), 'https://example.test')
    await vi.waitFor(() => expect(p.openInCate).toHaveBeenCalledWith('https://example.test'))
    expect(p.ask).toHaveBeenCalledWith('https://example.test')
    expect(p.remember).toHaveBeenCalledWith('canvas')
  })

  it('opens Shift+click and external targets outside', async () => {
    const p = ports('external')
    const handler = createTerminalLinkHandler(p, true)
    handler(click(true), 'https://a.test')
    handler(click(), 'https://b.test')
    await vi.waitFor(() => expect(p.openExternal).toHaveBeenCalledWith('https://b.test'))
    expect(p.openExternal).toHaveBeenCalledWith('https://a.test')
    expect(p.openInCate).not.toHaveBeenCalled()
  })

  it('does nothing when the person cancels or clicks without the modifier', async () => {
    const p = ports('ask', 'cancel')
    const handler = createTerminalLinkHandler(p, true)
    handler(click(), 'https://a.test')
    handler({ metaKey: false, ctrlKey: false, shiftKey: false } as MouseEvent, 'https://b.test')
    await vi.waitFor(() => expect(p.ask).toHaveBeenCalledTimes(1))
    expect(p.remember).not.toHaveBeenCalled()
    expect(p.openExternal).not.toHaveBeenCalled()
  })
})

describe('key handler', () => {
  const selection = { hasSelection: () => false }

  it('sends macOS line-editing chords as bytes', () => {
    const send = vi.fn()
    const event = key({ key: 'Backspace', metaKey: true })
    expect(makeTerminalKeyEventHandler(selection, send, true)(event)).toBe(false)
    expect(send).toHaveBeenCalledWith('\x15')
    expect(event.preventDefault).toHaveBeenCalled()
  })

  it('encodes modified special keys as CSI u but leaves app shortcuts alone', () => {
    const send = vi.fn()
    const handler = makeTerminalKeyEventHandler(selection, send, true)
    expect(handler(key({ key: 'Enter', shiftKey: true }))).toBe(false)
    expect(send).toHaveBeenCalledWith('\x1b[13;2u')
    expect(handler(key({ key: 'Tab', shiftKey: true }))).toBe(true)
    expect(handler(key({ key: 'Enter', metaKey: true, shiftKey: true }))).toBe(true)
    expect(handler(key({ key: 'a' }))).toBe(true)
  })

  it('lets the browser paste on Ctrl+V off Mac keyboards only', () => {
    expect(isTerminalPasteChord(key({ key: 'v', ctrlKey: true }), false)).toBe(true)
    expect(isTerminalPasteChord(key({ key: 'v', ctrlKey: true }), true)).toBe(false)
  })
})
