import { vi } from 'vitest'
import type { Subscription } from '@kernel/rpc/contract'

/** A stream subscription the test drives with `emit`. */
export function fakeStream<E>() {
  const listeners = new Set<(event: E) => void>()
  const sub = {
    onEvent(listener: (event: E) => void) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    onBytes: () => () => {},
    write() {},
    ack() {},
    done: new Promise<unknown>(() => {}),
    cancel: vi.fn(),
    [Symbol.asyncIterator]: () => { throw new Error('not iterable in tests') },
  }
  return {
    sub: sub as unknown as Subscription<E, unknown> & { cancel: ReturnType<typeof vi.fn> },
    emit(event: E) { for (const listener of [...listeners]) listener(event) },
  }
}
