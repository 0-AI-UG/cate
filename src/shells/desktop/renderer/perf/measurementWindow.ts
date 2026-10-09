/** Independent, bounded measurement windows for the HUD and automated runs. */
export function createMeasurementWindow() {
  let lastFrame: number | undefined
  let intervals = 0
  let totalMs = 0
  let maxMs = 0
  const histogram = new Map<number, number>()
  let longTaskCount = 0
  let longTaskMaxMs = 0
  let startedAt = 0
  return {
    frame(now: number) {
      if (lastFrame !== undefined) {
        const ms = now - lastFrame
        intervals++
        totalMs += ms
        maxMs = Math.max(maxMs, ms)
        // 0.1 ms buckets; exceptionally long gaps share an overflow bucket.
        const bucket = Math.min(100_000, Math.round(ms * 10))
        histogram.set(bucket, (histogram.get(bucket) ?? 0) + 1)
      }
      lastFrame = now
    },
    longTask(startTime: number, duration: number) {
      if (startTime < startedAt) return
      longTaskCount++
      longTaskMaxMs = Math.max(longTaskMaxMs, duration)
    },
    longTasks: () => ({ count: longTaskCount, maxMs: longTaskMaxMs }),
    frames() {
      let accumulated = 0
      let p95Ms = 0
      for (const [bucket, count] of [...histogram].sort((a, b) => a[0] - b[0])) {
        accumulated += count
        if (accumulated >= Math.ceil(intervals * 0.95)) { p95Ms = bucket / 10; break }
      }
      return { samples: intervals, fps: totalMs > 0 ? intervals * 1000 / totalMs : 0, meanMs: intervals ? totalMs / intervals : 0, p95Ms, maxMs }
    },
    reset(now: number) {
      startedAt = now
      lastFrame = undefined
      intervals = totalMs = maxMs = longTaskCount = longTaskMaxMs = 0
      histogram.clear()
    },
  }
}
