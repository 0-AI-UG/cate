// Draw-rate and scissor-area counters for the e2e perf harness. A no-op until
// the shell installs its perf counter (only under CATE_PERF=1).

let counter: ((name: string, n: number) => void) | null = null

export function setTerritoryPerfCounter(next: ((name: string, n: number) => void) | null): void {
  counter = next
}

export function territoryPerfCount(name: string, n = 1): void {
  counter?.(name, n)
}
