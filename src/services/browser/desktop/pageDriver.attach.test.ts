import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'
import { PageDriver } from './pageDriver'

it('waits for the same initialization when the surface and API attach concurrently', async () => {
  let finish!: () => void
  const pending = new Promise<void>(resolve => { finish = resolve })
  const debuggerEvents = new EventEmitter()
  const attach = vi.fn()
  const page = Object.assign(new EventEmitter(), {
    id: 1, isDestroyed: () => false,
    debugger: Object.assign(debuggerEvents, { isAttached: () => false, attach,
      sendCommand: vi.fn(async (method: string) => { if (method === 'Target.setAutoAttach') await pending; return {} }),
    }),
  })
  const driver = new PageDriver(page as never, { panelId: 'panel', tabId: 'tab' })
  const first = driver.attach()
  let ready = false
  const second = driver.attach().then(() => { ready = true })
  await Promise.resolve()
  expect(ready).toBe(false)
  finish()
  await Promise.all([first, second])
  expect(ready).toBe(true)
  expect(attach).toHaveBeenCalledTimes(1)
})
