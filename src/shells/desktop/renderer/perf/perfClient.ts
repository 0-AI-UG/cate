// Renderer profiling for the perf HUD, on only when main runs with
// CATE_PERF=1 (main then answers `app.perf()` with samples): render and work
// counters, a long-task observer and a rAF frame meter. Everything is a cheap
// no-op until `enablePerf()` runs.

import { setSurfacePerfCounter } from '../../ui/client/host/surfaceRegistry'
import { setCanvasPerfCounter, setTerritoryPerfCounter } from '../../ui/client/layout/canvas'
import { createMeasurementWindow } from './measurementWindow'

let enabled = false
const counts = new Map<string, number>()

export function perfEnabled(): boolean {
  return enabled
}

/** Bumps a named counter from a hot path; shown as `<name>/s`. */
export function perfCount(name: string, n = 1): void {
  if (!enabled) return
  counts.set(name, (counts.get(name) ?? 0) + n)
}

export function getRenderCounts(): Map<string, number> {
  return counts
}

const hudWindow = createMeasurementWindow()
const testWindow = createMeasurementWindow()
let longTasksSupported = false

export const isLongTaskObserverSupported = (): boolean => longTasksSupported
export const getLongTasks = hudWindow.longTasks
export const getFrameTimes = hudWindow.frames
export const getFps = (): number => Math.round(hudWindow.frames().fps)

declare global {
  interface Window {
    /** Only under CATE_PERF=1: read by the e2e perf harness. */
    __catePerf?: {
      frames(): ReturnType<ReturnType<typeof createMeasurementWindow>['frames']>
      longTasksSupported(): boolean
      fps(): number
      longTasks(): { count: number; maxMs: number }
      renderCounts(): Record<string, number>
      resetWindow(): void
    }
  }
}

function frameTick(now: number): void {
  hudWindow.frame(now)
  testWindow.frame(now)
  requestAnimationFrame(frameTick)
}

/** Starts the observers and routes the client's perf counters here. Once. */
export function enablePerf(): void {
  if (enabled) return
  enabled = true
  setSurfacePerfCounter(perfCount)
  setTerritoryPerfCounter(perfCount)
  setCanvasPerfCounter(perfCount)
  window.__catePerf = {
    frames: testWindow.frames,
    longTasksSupported: () => longTasksSupported,
    fps: () => Math.round(testWindow.frames().fps),
    longTasks: testWindow.longTasks,
    renderCounts: () => Object.fromEntries(counts),
    resetWindow: () => testWindow.reset(performance.now()),
  }
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        hudWindow.longTask(entry.startTime, entry.duration)
        testWindow.longTask(entry.startTime, entry.duration)
      }
    })
    observer.observe({ entryTypes: ['longtask'] })
    longTasksSupported = PerformanceObserver.supportedEntryTypes.includes('longtask')
  } catch {
    // No longtask entries in this Chromium build.
  }
  requestAnimationFrame(frameTick)
}

/** Starts the HUD's per-second window over. */
export function resetPerfWindow(): void {
  hudWindow.reset(performance.now())
}
