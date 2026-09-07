// =============================================================================
// perfClient — renderer-side profiling, active only under CATE_PERF=1.
//
// Provides:
//   - useRenderCount(name): counts component renders so the HUD can show
//     renders/sec during a pan, zoom, or agent stream (the cleanest before/after
//     signal for the memoization fixes in the perf audit).
//   - a long-task PerformanceObserver: any main-thread task >50ms is a dropped
//     frame; we tally count + worst duration per second.
//   - a rAF FPS meter.
//
// All counters are cheap integer bumps and are no-ops when disabled. The HUD
// (PerfHud.tsx) reads the rolling state via the getters below.
// =============================================================================

import { useEffect } from 'react'
import { createMeasurementWindow } from './measurementWindow'

export const PERF_ENABLED = Boolean(
  typeof window !== 'undefined' &&
    (window as unknown as { electronAPI?: { isPerf?: boolean } }).electronAPI?.isPerf,
)

// --- Render counts -----------------------------------------------------------
// Cumulative per-name counters; the HUD diffs against its own previous read to
// derive renders/sec, so we never reset here.
const renderCounts = new Map<string, number>()

function bumpRender(name: string): void {
  renderCounts.set(name, (renderCounts.get(name) ?? 0) + 1)
}

export function getRenderCounts(): Map<string, number> {
  return renderCounts
}

/**
 * Bump a named counter from a NON-component hot path (a store selector, an
 * event handler) that can't use the useRenderCount hook. Feeds the same map
 * the HUD and __catePerf.renderCounts() read, so instrumented paths show up
 * as "<name>/s" alongside component render rates. A no-op (single bool check)
 * when CATE_PERF is off, so it's safe to leave on a per-frame path.
 */
export function perfCount(name: string, n = 1): void {
  if (!PERF_ENABLED) return
  renderCounts.set(name, (renderCounts.get(name) ?? 0) + n)
}

/**
 * Count every commit of the calling component. Costs nothing when CATE_PERF is
 * off (the effect body early-returns). The empty-less effect runs after every
 * render, so it captures re-renders, not just mounts.
 */
export function useRenderCount(name: string): void {
  useEffect(() => {
    if (PERF_ENABLED) bumpRender(name)
  })
}

const hudWindow = createMeasurementWindow()
const testWindow = createMeasurementWindow()
let longTasksSupported = false

export const isLongTaskObserverSupported = (): boolean => longTasksSupported
export const getLongTasks = hudWindow.longTasks
export const getFrameTimes = hudWindow.frames
export const getFps = (): number => Math.round(hudWindow.frames().fps)

function frameTick(now: number): void {
  hudWindow.frame(now)
  testWindow.frame(now)
  requestAnimationFrame(frameTick)
}

let started = false

declare global {
  interface Window {
    /** Exposed only under CATE_PERF=1 — read by the e2e perf-stress harness. */
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

/** Wire up the renderer observers. Safe to call once per window; no-op when disabled. */
export function initPerfClient(): void {
  if (!PERF_ENABLED || started) return
  started = true

  // Expose a read API for the e2e perf-stress test (page.evaluate reads these).
  window.__catePerf = {
    frames: testWindow.frames,
    longTasksSupported: () => longTasksSupported,
    fps: () => Math.round(testWindow.frames().fps),
    longTasks: testWindow.longTasks,
    renderCounts: () => Object.fromEntries(renderCounts),
    resetWindow: () => testWindow.reset(performance.now()),
  }

  try {
    const longTaskObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        hudWindow.longTask(entry.startTime, entry.duration)
        testWindow.longTask(entry.startTime, entry.duration)
      }
    })
    longTaskObserver.observe({ entryTypes: ['longtask'] })
    longTasksSupported = PerformanceObserver.supportedEntryTypes.includes('longtask')
  } catch {
    // longtask not supported in this Chromium build — skip silently.
  }

  requestAnimationFrame(frameTick)
}

/** Reset the per-second rolling counters. The HUD calls this after each read. */
export function resetPerfWindow(): void {
  hudWindow.reset(performance.now())
}
