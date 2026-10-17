import { expect, it, vi } from 'vitest'
import { createMemoryDeviceStore } from './deviceStore'

it('stores copies and delivers outside changes to subscribers', async () => {
  const store = createMemoryDeviceStore({ recents: ['a'] })
  const value = { x: 1 }
  await store.set('doc', value)
  value.x = 2
  expect(await store.get('doc')).toEqual({ x: 1 })
  expect(await store.get('missing')).toBeUndefined()

  const cb = vi.fn()
  const off = store.subscribe('recents', cb)
  store.change('recents', ['b'])
  expect(cb).toHaveBeenCalledWith(['b'])
  off()
  store.change('recents', ['c'])
  expect(cb).toHaveBeenCalledTimes(1)
})
