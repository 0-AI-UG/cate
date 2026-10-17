import { describe, it, expect } from 'vitest'
import { KeyedLock } from './keyedLock'

const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('KeyedLock', () => {
  it('serializes work for the same key in call order', async () => {
    const lock = new KeyedLock()
    const order: number[] = []

    const a = lock.run('k', async () => { await tick(20); order.push(1) })
    const b = lock.run('k', async () => { await tick(1); order.push(2) })
    const c = lock.run('k', async () => { order.push(3) })

    await Promise.all([a, b, c])
    // Second must wait for the slow first despite finishing sooner on its own.
    expect(order).toEqual([1, 2, 3])
  })

  it('does not block the next queued fn when one rejects', async () => {
    const lock = new KeyedLock()
    const order: string[] = []

    const failing = lock.run('k', async () => { order.push('fail'); throw new Error('boom') })
    const next = lock.run('k', async () => { order.push('next'); return 'ok' })

    await expect(failing).rejects.toThrow('boom')
    await expect(next).resolves.toBe('ok')
    expect(order).toEqual(['fail', 'next'])
  })

  it('runs different keys independently', async () => {
    const lock = new KeyedLock()
    const order: string[] = []

    const slow = lock.run('a', async () => { await tick(20); order.push('a') })
    const fast = lock.run('b', async () => { order.push('b') })

    await Promise.all([slow, fast])
    // 'b' need not wait for 'a' — a different key is a separate chain.
    expect(order).toEqual(['b', 'a'])
  })
})
