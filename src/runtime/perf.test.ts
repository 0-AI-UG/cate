import { afterEach, expect, it, vi } from 'vitest'

vi.mock('node:perf_hooks', () => ({ monitorEventLoopDelay: () => ({ enable: vi.fn(), reset: vi.fn(), percentile: () => 20_000_000, max: 30_000_000 }) }))
afterEach(() => vi.restoreAllMocks())

it('enables counting explicitly and uses the actual sample interval', async () => {
  vi.resetModules()
  const { countMonitorScan, countMonitorSpawn, sampleRuntimePerf } = await import('./perf')
  let now = 1000
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  countMonitorSpawn('ps')
  expect(sampleRuntimePerf().monitorSpawnsPerSec).toEqual({})
  countMonitorSpawn('ps')
  countMonitorSpawn('lsof')
  countMonitorScan('activity')
  now += 4000
  const sample = sampleRuntimePerf()
  expect(sample.windowMs).toBe(4000)
  expect(sample.monitorSpawnsPerSec).toEqual({ ps: 0.25, lsof: 0.25 })
  expect(sample.monitorScansPerSec).toEqual({ activity: 0.25 })
  expect(sample.eventLoop).toEqual({ p95Ms: 20, maxMs: 30 })
  now += 2000
  expect(sampleRuntimePerf().monitorSpawnsPerSec).toEqual({})
})
