// Canvas work counters for the perf HUD and the e2e perf harness (the cull:
// `canvasCullEval` per evaluation, `canvasCullSort` per real sort). A no-op
// until the shell installs its perf counter (only under CATE_PERF=1).

let counter: ((name: string, n: number) => void) | null = null

export function setCanvasPerfCounter(next: ((name: string, n: number) => void) | null): void {
  counter = next
}

export function canvasPerfCount(name: string, n = 1): void {
  counter?.(name, n)
}
