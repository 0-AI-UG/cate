type KeyboardModifier = 'Alt' | 'Control' | 'Meta' | 'Shift'

export type BrowserInputRequest =
  | { input: 'insertText' | 'replaceText'; text?: string; delay?: number }
  | { input: 'key'; key?: string; modifiers?: KeyboardModifier[] }

interface GuestInputTarget {
  focus(): void
  sendInputEvent(event: {
    type: 'keyDown' | 'keyUp' | 'char'
    keyCode: string
    modifiers?: Array<'alt' | 'control' | 'meta' | 'shift'>
  }): void
}

const MODIFIER_NAMES: Record<KeyboardModifier, 'alt' | 'control' | 'meta' | 'shift'> = {
  Alt: 'alt',
  Control: 'control',
  Meta: 'meta',
  Shift: 'shift',
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Deliver trusted keyboard input directly to the guest webContents. Focusing a
 * DOM element through executeJavaScript is not enough: when a Cate terminal
 * issued the command, Electron's native input target is still that terminal.
 */
export async function dispatchBrowserInput(
  target: GuestInputTarget,
  request: BrowserInputRequest,
): Promise<void> {
  target.focus()

  if (request.input !== 'key') {
    if (request.input === 'replaceText') {
      target.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace' })
      target.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace' })
    }
    const delay = Math.max(0, request.delay ?? 0)
    for (const char of [...(request.text ?? '')]) {
      target.sendInputEvent({ type: 'char', keyCode: char })
      if (delay > 0) await sleep(delay)
    }
    return
  }

  const keyCode = request.key
  if (!keyCode) throw new Error('key-required')
  const modifiers = request.modifiers?.map((modifier) => MODIFIER_NAMES[modifier])
  const eventModifiers = modifiers?.length ? modifiers : undefined
  target.sendInputEvent({ type: 'keyDown', keyCode, modifiers: eventModifiers })
  if (!eventModifiers && (
    [...keyCode].length === 1 || keyCode === 'Return' || keyCode === 'Space' || keyCode === 'Tab'
  )) {
    target.sendInputEvent({ type: 'char', keyCode, modifiers: eventModifiers })
  }
  target.sendInputEvent({ type: 'keyUp', keyCode, modifiers: eventModifiers })
}
