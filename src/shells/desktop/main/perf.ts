// The app's resource profiler for the perf HUD, active only with CATE_PERF=1:
// per-process CPU and memory of this app every 2 s. Runtime numbers come from
// each runtime's `runtime.perf` through the renderer's connection.

import { app, BrowserWindow } from 'electron'
import { createLogger } from '@kernel/log/contract'
import type { AppPerfSnapshot } from '../contract'

const log = createLogger('perf')
const SAMPLE_INTERVAL_MS = 2000

export function startPerfMonitor(enabled: boolean): { latest(): AppPerfSnapshot | null } {
  let latest: AppPerfSnapshot | null = null
  if (!enabled) return { latest: () => null }
  let previous = performance.now()
  const timer = setInterval(() => {
    const now = performance.now()
    const windowMs = now - previous
    previous = now
    let totalCpu = 0
    const procs = app.getAppMetrics().map((metric) => {
      const cpu = Math.round((metric.cpu?.percentCPUUsage ?? 0) * 10) / 10
      totalCpu += cpu
      return { type: metric.type, pid: metric.pid, cpu, memMB: Math.round((metric.memory?.workingSetSize ?? 0) / 1024) }
    }).sort((a, b) => b.cpu - a.cpu)
    latest = {
      sampledAt: Date.now(),
      windowMs,
      focused: BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && w.isFocused()),
      totalCpu: Math.round(totalCpu * 10) / 10,
      procs,
    }
    log.info('cpu=%s%% focused=%s', latest.totalCpu, latest.focused)
  }, SAMPLE_INTERVAL_MS)
  timer.unref?.()
  log.info('CATE_PERF=1: sampling every %d ms', SAMPLE_INTERVAL_MS)
  return { latest: () => latest }
}
