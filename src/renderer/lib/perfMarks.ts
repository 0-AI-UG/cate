// =============================================================================
// perfMarks — tiny wrapper over performance.mark for instrumenting
// cold-launch and other startup-critical paths without a heavy tracing
// dependency.
//
// Usage:
//   import { mark } from './lib/perfMarks'
//   mark('renderer-script-start')
// =============================================================================

function hasPerformance(): boolean {
  return typeof performance !== 'undefined' && typeof performance.mark === 'function'
}

export function mark(name: string): void {
  if (hasPerformance()) {
    try { performance.mark(name) } catch { /* duplicate name, ignore */ }
  }
}
