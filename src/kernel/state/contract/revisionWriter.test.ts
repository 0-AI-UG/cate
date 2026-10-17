import { expect, it, vi } from 'vitest'
import { createRevisionWriter } from './revisionWriter'

it('serializes publication and drains mutations made during capture', async () => {
  let release!: () => void
  let value = 1
  const published: number[] = []
  const write = vi.fn(async () => {
    const captured = value
    if (captured === 1) await new Promise<void>(resolve => { release = resolve })
    published.push(captured)
  })
  const owner = createRevisionWriter(write)
  owner.markDirty()
  const first = owner.flush()
  value = 2
  owner.markDirty()
  const second = owner.flush()
  expect(write).toHaveBeenCalledOnce()
  release()
  await Promise.all([first, second])
  expect(published).toEqual([1, 2])
  await owner.flush()
  expect(write).toHaveBeenCalledTimes(2)
})

it('does not mark failed publication durable and retries unchanged state', async () => {
  const write = vi.fn().mockRejectedValueOnce(new Error('disk full')).mockResolvedValue(undefined)
  const owner = createRevisionWriter(write)
  owner.markDirty()
  await expect(owner.flush()).rejects.toThrow('disk full')
  await owner.flush()
  expect(write).toHaveBeenCalledTimes(2)
})

it('includes a mutation queued as the previous write completes', async () => {
  const write = vi.fn(async () => {})
  const owner = createRevisionWriter(write)
  owner.markDirty()
  const first = owner.flush()
  let second: Promise<void> | undefined
  queueMicrotask(() => { owner.markDirty(); second = owner.flush() })
  await first
  await second
  expect(write).toHaveBeenCalledTimes(2)
})
