import { monitorEventLoopDelay } from 'node:perf_hooks'
import type { RuntimePerfSample } from '../shared/types'

let enabled = false
const spawns = new Map<string, number>()
const scans = new Map<string, number>()
let previousAt = 0
let previousCpu = process.cpuUsage()
let delay: ReturnType<typeof monitorEventLoopDelay> | undefined

/** Counts actual process-monitor launches, on the host that executes them. */
export function countMonitorSpawn(command: string): void {
  if (enabled) spawns.set(command, (spawns.get(command) ?? 0) + 1)
}

export function countMonitorScan(kind: string): void {
  if (enabled) scans.set(kind, (scans.get(kind) ?? 0) + 1)
}

/** Profiling is enabled by an explicit RPC; normal daemon sessions pay no
 * timer/observer cost. The first sample establishes the measurement baseline. */
export function sampleRuntimePerf(): RuntimePerfSample {
  const now = performance.now()
  const cpu = process.cpuUsage()
  const windowMs = enabled ? now - previousAt : 0
  const sample: RuntimePerfSample = {
    pid: process.pid,
    platform: process.platform,
    windowMs,
    cpu: windowMs > 0 ? ((cpu.user - previousCpu.user + cpu.system - previousCpu.system) / (windowMs * 10)) : 0,
    rssMB: process.memoryUsage().rss / 1024 / 1024,
    monitorScansPerSec: Object.fromEntries([...scans].map(([name, count]) => [name, windowMs > 0 ? count * 1000 / windowMs : 0])),
    monitorSpawnsPerSec: Object.fromEntries([...spawns].map(([name, count]) => [name, windowMs > 0 ? count * 1000 / windowMs : 0])),
    eventLoop: { p95Ms: (delay?.percentile(95) ?? 0) / 1e6, maxMs: (delay?.max ?? 0) / 1e6 },
  }
  if (!enabled) {
    enabled = true
    delay = monitorEventLoopDelay({ resolution: 20 })
    delay.enable()
  }
  delay?.reset()
  spawns.clear()
  scans.clear()
  previousAt = now
  previousCpu = cpu
  return sample
}
