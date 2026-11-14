import { expect, it, vi } from 'vitest'
import type { CallContext, RpcServer } from '@kernel/rpc/runtime'
import type { RuntimeUpdateProgress } from '../contract'
import type { PerfSampler } from './perf'
import { runtimeCapabilityImpl } from './runtimeCapability'

function setup(opts: { clients?: number[]; otherVersions?: number[]; busy?: boolean } = {}) {
  const restart = vi.fn()
  let finish!: () => void
  let report!: (progress: RuntimeUpdateProgress) => void
  const update = vi.fn((_target: unknown, onProgress: (progress: RuntimeUpdateProgress) => void) => {
    report = onProgress
    return new Promise<() => void>((resolve) => { finish = () => resolve(restart) })
  })
  const rpc = {
    connections: () => [
      ...(opts.clients ?? [1]).map((id) => ({ id, compatible: true, client: { clientId: `c${id}`, device: { name: 'd', publicKey: 'f' }, features: [] } })),
      ...(opts.otherVersions ?? []).map((id) => ({ id, compatible: false, client: { clientId: `c${id}`, device: { name: 'd', publicKey: 'f' }, features: [] } })),
    ],
  } as unknown as RpcServer
  const impl = runtimeCapabilityImpl({
    runtimeId: 'r', root: '/w', machineName: 'm', machineSleeps: true, version: '2.0.4', rpc, perf: {} as PerfSampler,
    endpoints: () => [{ kind: 'lan', address: '10.0.0.2', port: 4000 }],
    busy: () => opts.busy ?? false,
    stop: () => {},
    onStopping: () => () => {},
    prepareUpdate: update,
  })
  const ctx = { connection: { id: 1 } } as unknown as CallContext
  const call = (params: { version: string; build?: string; ifIdle?: boolean }) =>
    (impl.update as (p: typeof params, c: CallContext) => Promise<void>)(params, ctx)
  const progress = () => (impl.updateProgress as () => RuntimeUpdateProgress | null)()
  return { impl, call, update, restart, progress, report: (p: RuntimeUpdateProgress) => report(p), finish: () => finish() }
}

it('says where paired devices reach it now', () => {
  const { impl } = setup()
  expect((impl.info as unknown as () => { endpoints?: unknown })().endpoints).toEqual([{ kind: 'lan', address: '10.0.0.2', port: 4000 }])
})

it('validates the version and build', async () => {
  const { call } = setup()
  await expect(call({ version: 'latest' })).rejects.toMatchObject({ code: 'rejected' })
  await expect(call({ version: '2.0.5', build: '2.0.4+aaaaaaaaaaaa' })).rejects.toMatchObject({ code: 'rejected' })
  await expect(call({ version: '2.0.5', build: '2.0.5+nothex' })).rejects.toMatchObject({ code: 'rejected' })
  await expect(call({ version: '2.0.3' })).rejects.toMatchObject({ code: 'rejected' })
  await expect(call({ version: '2.0.4-beta.1' })).rejects.toMatchObject({ code: 'rejected' })
})

it('refuses an idle-only update while another client is connected or work runs', async () => {
  await expect(setup({ clients: [1, 2] }).call({ version: '2.0.5', ifIdle: true })).rejects.toMatchObject({ code: 'dirty', data: { reason: 'shared' } })
  await expect(setup({ busy: true }).call({ version: '2.0.5', ifIdle: true })).rejects.toMatchObject({ code: 'dirty', data: { reason: 'busy' } })
  // The caller itself does not count, nor a client of another version (it
  // cannot use the runtime); without ifIdle other clients do not matter.
  const alone = setup({ otherVersions: [3] })
  const done = alone.call({ version: '2.0.5', ifIdle: true })
  alone.finish()
  await done
  expect(alone.update).toHaveBeenCalledWith({ version: '2.0.5' }, expect.any(Function))
})

it.each(['shared', 'busy'])('does not restart if the workspace becomes %s during installation', async (reason) => {
  const options = { clients: [1], busy: false }
  const runtime = setup(options)
  const done = runtime.call({ version: '2.0.5', ifIdle: true })
  if (reason === 'shared') options.clients.push(2)
  else options.busy = true
  runtime.finish()
  await expect(done).rejects.toMatchObject({ code: 'dirty', data: { reason } })
  expect(runtime.restart).not.toHaveBeenCalled()
  // The prepared install can be retried with an explicit choice.
  const confirmed = runtime.call({ version: '2.0.5' })
  runtime.finish()
  await confirmed
  expect(runtime.restart).toHaveBeenCalledTimes(1)
})

it('allows a confirmed shared restart even with other clients and running work', async () => {
  const shared = setup({ clients: [1, 2], busy: true })
  const done = shared.call({ version: '2.0.5' })
  shared.finish()
  await done
  expect(shared.update).toHaveBeenCalledTimes(1)
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
