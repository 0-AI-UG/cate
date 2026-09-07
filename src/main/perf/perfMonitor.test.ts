import { afterEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ samplePerf: vi.fn() }))
vi.mock('electron', () => ({
  app: { getAppMetrics: () => [] },
  BrowserWindow: { getAllWindows: () => [] },
}))
vi.mock('../runtime/runtimeManager', () => ({ runtimes: { connectedRuntimes: () => [{ id: 'local', samplePerf: mocks.samplePerf }] } }))
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks() })

it('publishes daemon counters atomically and reports unavailable profiling explicitly', async () => {
  vi.useFakeTimers()
  vi.stubEnv('CATE_PERF', '1')
  vi.resetModules()
  const perf = await import('./perfMonitor')
  mocks.samplePerf.mockResolvedValue({ pid: 123, windowMs: 2000, monitorSpawnsPerSec: { ps: 1.5 }, monitorScansPerSec: { activity: 1 }, cpu: 2, rssMB: 40, eventLoop: { p95Ms: 20, maxMs: 21 } })
  perf.startPerfMonitor()
  perf.countIpc('terminal', 4096)
  await vi.advanceTimersByTimeAsync(2000)
  expect(perf.getLatestSnapshot()).toMatchObject({ spawnsPerSec: { ps: 1.5 }, runtimes: [{ id: 'local', sample: { pid: 123 } }] })
  mocks.samplePerf.mockRejectedValue(new Error('Unknown method'))
  await vi.advanceTimersByTimeAsync(2000)
  expect(perf.getLatestSnapshot()).toMatchObject({ spawnsPerSec: {}, runtimes: [{ id: 'local', sample: null, error: 'Unknown method' }] })
})
