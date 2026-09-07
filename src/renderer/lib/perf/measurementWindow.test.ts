import { expect, it } from 'vitest'
import { createMeasurementWindow } from './measurementWindow'

it('keeps benchmark long tasks and frame stalls when the HUD resets', () => {
  const hud = createMeasurementWindow()
  const benchmark = createMeasurementWindow()
  for (const window of [hud, benchmark]) {
    window.reset(0)
    for (const time of [0, 10, 20, 120]) window.frame(time)
    window.longTask(20, 100)
  }
  hud.reset(121)
  expect(hud.longTasks().count).toBe(0)
  expect(benchmark.longTasks()).toEqual({ count: 1, maxMs: 100 })
  expect(benchmark.frames()).toEqual({ samples: 3, fps: 25, meanMs: 40, p95Ms: 100, maxMs: 100 })
  benchmark.reset(130)
  benchmark.longTask(120, 90) // Observer delivery from the preceding window.
  expect(benchmark.longTasks().count).toBe(0)
  expect(benchmark.frames().samples).toBe(0)
  benchmark.frame(500)
  benchmark.frame(510)
  expect(benchmark.frames().meanMs).toBe(10)
})
