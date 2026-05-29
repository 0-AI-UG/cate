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

export const PERF_ENABLED = Boolean(
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
 * Count every commit of the calling component. Costs nothing when CATE_PERF is
 * off (the effect body early-returns). The empty-less effect runs after every
 * render, so it captures re-renders, not just mounts.
 */
export function useRenderCount(name: string): void {
  useEffect(() => {
    if (PERF_ENABLED) bumpRender(name)
  })
}

// --- Long tasks --------------------------------------------------------------
let longTaskCount = 0
let longTaskMaxMs = 0
let longTaskObserver: PerformanceObserver | null = null

export function getLongTasks(): { count: number; maxMs: number } {
  return { count: longTaskCount, maxMs: longTaskMaxMs }
}

// --- FPS ---------------------------------------------------------------------
let fps = 0
let frameCount = 0
let lastFpsAt = 0
let rafHandle = 0

export function getFps(): number {
  return fps
}

function frameTick(now: number): void {
  frameCount++
  if (lastFpsAt === 0) lastFpsAt = now
  const elapsed = now - lastFpsAt
  if (elapsed >= 1000) {
    fps = Math.round((frameCount * 1000) / elapsed)
    frameCount = 0
    lastFpsAt = now
  }
  rafHandle = requestAnimationFrame(frameTick)
}

let started = false

declare global {
  interface Window {
    /** Exposed only under CATE_PERF=1 — read by the e2e perf-stress harness. */
    __catePerf?: {
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
    fps: () => fps,
    longTasks: () => ({ count: longTaskCount, maxMs: longTaskMaxMs }),
    renderCounts: () => Object.fromEntries(renderCounts),
    resetWindow: () => resetPerfWindow(),
  }

  try {
    longTaskObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        longTaskCount++
        if (entry.duration > longTaskMaxMs) longTaskMaxMs = entry.duration
      }
    })
    longTaskObserver.observe({ entryTypes: ['longtask'] })
  } catch {
    // longtask not supported in this Chromium build — skip silently.
  }

  rafHandle = requestAnimationFrame(frameTick)
}

/** Reset the per-second rolling counters. The HUD calls this after each read. */
export function resetPerfWindow(): void {
  longTaskCount = 0
  longTaskMaxMs = 0
}

export function stopPerfClient(): void {
  if (longTaskObserver) { longTaskObserver.disconnect(); longTaskObserver = null }
  if (rafHandle) { cancelAnimationFrame(rafHandle); rafHandle = 0 }
  started = false
}
