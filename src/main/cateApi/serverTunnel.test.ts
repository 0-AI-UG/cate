import { expect, it, vi } from 'vitest'
import { openTunnelDuplex, reverseDuplex } from './serverTunnel'
import { bindReverseTunnel } from './cateApiReverse'
import type { Runtime } from '../runtime/types'
vi.mock('../browser/browserCodeSession', () => ({ browserCodeSessions: {} }))
vi.mock('../windowPanels', () => ({ getWindowPanels: vi.fn() }))
vi.mock('../windowRegistry', () => ({ getWindow: vi.fn() }))
vi.mock('./cateApiHandlers', () => ({ authorizeCateInvoke: vi.fn(), dispatchCateInvoke: vi.fn(), forwardToActiveWindow: vi.fn(), forwardToOwner: vi.fn() }))
vi.mock('../logger', () => ({ default: { warn: vi.fn() } }))

it('withholds forward tunnel credit until a full readable buffer is consumed', async () => {
  let deliver!: (id: string, data: string) => void
  let id = ''
  const ack = vi.fn()
  const runtime = { tunnel: { open: vi.fn(async (key: string, _port: number, cb: typeof deliver) => { id = key; deliver = cb }), ack, close: vi.fn(), write: vi.fn() } } as unknown as Runtime
  const stream = await openTunnelDuplex(runtime, 1)
  const chunk = Buffer.alloc(128 * 1024, 65)
  deliver(id, chunk.toString('base64'))
  expect(ack).not.toHaveBeenCalled()
  expect(stream.read()).toEqual(chunk)
  await new Promise(resolve => setImmediate(resolve))
  expect(ack).toHaveBeenCalledWith(id, chunk.length)
  stream.destroy()
})
it('applies the same readable credit policy to reverse tunnel connections', async () => {
  let connection!: (id: string) => void
  let deliver!: (id: string, data: string) => void
  const ack = vi.fn()
  const runtime = { tunnel: { listen: vi.fn(async (_id: string, onConnection: typeof connection, onData: typeof deliver) => { connection = onConnection; deliver = onData; return { port: 1 } }), ack, close: vi.fn(), write: vi.fn(), stopListen: vi.fn() } } as unknown as Runtime
  const stream = reverseDuplex(runtime, 'reverse')
  const endpoint = { feedConnection: () => stream, dispose: () => stream.destroy() }
  const binding = await bindReverseTunnel(runtime, endpoint as any, 'listener')
  connection('reverse')
  const chunk = Buffer.alloc(128 * 1024, 66)
  deliver('reverse', chunk.toString('base64'))
  expect(ack).not.toHaveBeenCalled()
  expect(stream.read()).toEqual(chunk)
  await new Promise(resolve => setImmediate(resolve))
  expect(ack).toHaveBeenCalledWith('reverse', chunk.length)
  binding.dispose()
})
