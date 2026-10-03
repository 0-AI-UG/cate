import { expect, it, vi } from 'vitest'
import type { CallContext, RpcServer } from '@kernel/rpc/runtime'
import type { RuntimeUpdateProgress } from '../contract'
import type { PerfSampler } from './perf'
import { runtimeCapabilityImpl } from './runtimeCapability'

function setup(opts: { clients?: number[]; busy?: boolean } = {}) {
  let finish!: () => void
  let report!: (progress: RuntimeUpdateProgress) => void
  const update = vi.fn((_target: unknown, onProgress: (progress: RuntimeUpdateProgress) => void) => {
    report = onProgress
    return new Promise<void>((resolve) => { finish = resolve })
  })
  const rpc = {
    protocol: [1, 0],
    connections: () => (opts.clients ?? [1]).map((id) => ({ id, client: { clientId: `c${id}`, device: { name: 'd', keyFingerprint: 'f' }, features: [] } })),
  } as unknown as RpcServer
  const impl = runtimeCapabilityImpl({
    runtimeId: 'r', root: '/w', version: '2.0.4', rpc, perf: {} as PerfSampler,
    busy: () => opts.busy ?? false,
    stop: () => {},
    onStopping: () => () => {},
    update,
  })
  const ctx = { connection: { id: 1 } } as unknown as CallContext
  const call = (params: { version: string; build?: string; ifIdle?: boolean }) =>
    (impl.update as (p: typeof params, c: CallContext) => Promise<void>)(params, ctx)
  const progress = () => (impl.updateProgress as () => RuntimeUpdateProgress | null)()
  return { call, update, progress, report: (p: RuntimeUpdateProgress) => report(p), finish: () => finish() }
}

it('validates the version and build', async () => {
  const { call } = setup()
  await expect(call({ version: 'latest' })).rejects.toMatchObject({ code: 'rejected' })
  await expect(call({ version: '2.0.5', build: '2.0.4+aaaaaaaaaaaa' })).rejects.toMatchObject({ code: 'rejected' })
  await expect(call({ version: '2.0.5', build: '2.0.5+nothex' })).rejects.toMatchObject({ code: 'rejected' })
})

it('refuses an idle-only update while another client is connected or work runs', async () => {
  await expect(setup({ clients: [1, 2] }).call({ version: '2.0.5', ifIdle: true })).rejects.toMatchObject({ code: 'dirty' })
  await expect(setup({ busy: true }).call({ version: '2.0.5', ifIdle: true })).rejects.toMatchObject({ code: 'dirty' })
  // The caller itself does not count; without ifIdle other clients do not matter.
  const alone = setup()
  const done = alone.call({ version: '2.0.5', ifIdle: true })
  alone.finish()
  await done
  expect(alone.update).toHaveBeenCalledWith({ version: '2.0.5' }, expect.any(Function))
})

it('runs one update at a time', async () => {
  const { call, update, finish } = setup()
  const build = '2.0.5+aaaaaaaaaaaa'
  const first = call({ version: '2.0.5', build })
  const second = call({ version: '2.0.5', build })
  await expect(call({ version: '2.0.6' })).rejects.toMatchObject({ code: 'conflict' })
  finish()
  await Promise.all([first, second])
  expect(update).toHaveBeenCalledTimes(1)
  expect(update).toHaveBeenCalledWith({ version: '2.0.5', build }, expect.any(Function))
})

it('reports the running update\'s progress', async () => {
  const { call, progress, report, finish } = setup()
  expect(progress()).toBeNull()
  const done = call({ version: '2.0.5' })
  expect(progress()).toBeNull()
  report({ phase: 'download', received: 10, total: 100 })
  expect(progress()).toEqual({ phase: 'download', received: 10, total: 100 })
  report({ phase: 'install' })
  expect(progress()).toEqual({ phase: 'install' })
  finish()
  await done
})
