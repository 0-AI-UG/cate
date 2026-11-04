import { expect, it, vi } from 'vitest'
import { createOpenRequests } from './openRequests'

it('queues a cold-start pairing URL until the renderer is ready, then forwards subsequent launches', () => {
  const send = vi.fn()
  const contents = { send, isDestroyed: () => false, on: vi.fn() }
  const requests = createOpenRequests({
    target: () => ({ contents, focus: vi.fn() }) as never,
    createMainWindow: vi.fn(), started: () => false,
    channels: { path: 'path', url: 'url' }, focusOnDeliver: false,
  })
  const link = 'cate://pair?r=abc&s=def'
  requests.openUrlsFromArgs(['/electron', '/checkout', '--inspect=1234', link])
  expect(send).not.toHaveBeenCalled()
  requests.markReady(contents as never)
  expect(send).toHaveBeenCalledExactlyOnceWith('url', link)
  requests.openUrlsFromArgs(['/electron', link])
  expect(send).toHaveBeenCalledTimes(2)
})
