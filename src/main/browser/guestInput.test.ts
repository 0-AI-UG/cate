import { describe, expect, it, vi } from 'vitest'
import { dispatchBrowserInput } from './guestInput'

function target() {
  return {
    focus: vi.fn(),
    sendInputEvent: vi.fn(),
  }
}

describe('dispatchBrowserInput', () => {
  it('focuses the guest before inserting trusted character events', async () => {
    const guest = target()
    await dispatchBrowserInput(guest, { input: 'insertText', text: 'hi' })

    expect(guest.focus).toHaveBeenCalledOnce()
    expect(guest.focus.mock.invocationCallOrder[0]).toBeLessThan(
      guest.sendInputEvent.mock.invocationCallOrder[0],
    )
    expect(guest.sendInputEvent.mock.calls.map(([event]) => event)).toEqual([
      { type: 'char', keyCode: 'h' },
      { type: 'char', keyCode: 'i' },
    ])
  })

  it('clears the selected value before replacement, including an empty fill', async () => {
    const guest = target()
    await dispatchBrowserInput(guest, { input: 'replaceText', text: '' })

    expect(guest.sendInputEvent.mock.calls.map(([event]) => event)).toEqual([
      { type: 'keyDown', keyCode: 'Backspace' },
      { type: 'keyUp', keyCode: 'Backspace' },
    ])
  })

  it('dispatches named keys with Electron modifier names and a char event when needed', async () => {
    const guest = target()
    await dispatchBrowserInput(guest, { input: 'key', key: 'Return', modifiers: [] })
    expect(guest.sendInputEvent.mock.calls.map(([event]) => event.type)).toEqual([
      'keyDown',
      'char',
      'keyUp',
    ])

    guest.sendInputEvent.mockClear()
    await dispatchBrowserInput(guest, { input: 'key', key: 'a', modifiers: ['Meta', 'Shift'] })
    expect(guest.sendInputEvent.mock.calls.map(([event]) => event)).toEqual([
      { type: 'keyDown', keyCode: 'a', modifiers: ['meta', 'shift'] },
      { type: 'keyUp', keyCode: 'a', modifiers: ['meta', 'shift'] },
    ])
  })
})
