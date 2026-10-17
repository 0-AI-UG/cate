// `runtime.perf`: sampling starts with the first call, so a runtime nobody
// profiles pays no timer or observer cost.

import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks'
import type { RuntimePerfSample } from '../contract'

export interface PerfSampler {
  /** Counts an event (a process scan, a spawn) toward the next sample's rates. */
  count(name: string): void
  sample(): RuntimePerfSample
}

export function createPerfSampler(): PerfSampler {
  let enabled = false
  const counts = new Map<string, number>()
  let previousAt = 0
  let previousCpu = process.cpuUsage()
  let delay: IntervalHistogram | undefined

  return {
    count(name) {
      if (enabled) counts.set(name, (counts.get(name) ?? 0) + 1)
    },
    sample() {
      const now = performance.now()
      const cpu = process.cpuUsage()
      const windowMs = enabled ? now - previousAt : 0
      const rate = (count: number) => (windowMs > 0 ? (count * 1000) / windowMs : 0)
      const result: RuntimePerfSample = {
        pid: process.pid,
        platform: process.platform,
        windowMs,
        cpu: windowMs > 0 ? (cpu.user - previousCpu.user + cpu.system - previousCpu.system) / (windowMs * 10) : 0,
        rssMB: process.memoryUsage().rss / 1024 / 1024,
        eventLoop: { p95Ms: (delay?.percentile(95) ?? 0) / 1e6, maxMs: (delay?.max ?? 0) / 1e6 },
        counters: Object.fromEntries([...counts].map(([name, count]) => [name, rate(count)])),
      }
      if (!enabled) {
        enabled = true
        delay = monitorEventLoopDelay({ resolution: 20 })
        delay.enable()
      }
      delay?.reset()
      counts.clear()
      previousAt = now
      previousCpu = cpu
      return result
    },
  }
}
