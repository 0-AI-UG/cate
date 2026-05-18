// =============================================================================
// perfMarks — tiny wrapper over performance.mark / performance.measure with a
// ring buffer of recent entries. Used to instrument cold-launch and other
// startup-critical paths without a heavy tracing dependency.
//
// Usage:
//   import { mark, measure, getEntries } from './lib/perfMarks'
//   mark('renderer-script-start')
//   measure('boot-to-paint', 'renderer-script-start', 'first-paint')
//   console.table(getEntries())
// =============================================================================

interface PerfEntry {
  type: 'mark' | 'measure'
  name: string
  /** For marks: timestamp. For measures: start time. */
  time: number
  /** For measures: duration in ms. */
  duration?: number
}

const RING_SIZE = 256
const ring: PerfEntry[] = []

function push(entry: PerfEntry): void {
  ring.push(entry)
  if (ring.length > RING_SIZE) ring.shift()
}

function hasPerformance(): boolean {
  return typeof performance !== 'undefined' && typeof performance.mark === 'function'
}

export function mark(name: string): void {
  const time = hasPerformance() ? performance.now() : Date.now()
  if (hasPerformance()) {
    try { performance.mark(name) } catch { /* duplicate name, ignore */ }
  }
  push({ type: 'mark', name, time })
}

export function measure(name: string, start: string, end?: string): void {
  if (!hasPerformance()) return
  try {
    const m = end ? performance.measure(name, start, end) : performance.measure(name, start)
    push({ type: 'measure', name, time: m.startTime, duration: m.duration })
  } catch {
    // Either mark wasn't recorded yet, or browser refused — silently drop.
  }
}

export function getEntries(): readonly PerfEntry[] {
  return ring.slice()
}
