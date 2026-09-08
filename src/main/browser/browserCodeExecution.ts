// Main-owned cell authority travels through renderer forwarding as an opaque ID.
// Removing it cancels queued work; checking the deadline also covers a delayed timer.
const activeCells = new Map<string, number>()

export function beginBrowserCodeCell(id: string, deadline: number): void {
  activeCells.set(id, deadline)
}

export function endBrowserCodeCell(id: string): void {
  activeCells.delete(id)
}

export function assertBrowserCodeCell(id: unknown): void {
  if (id === undefined) return // Direct UI/IPC callers do not belong to a code cell.
  if (typeof id !== 'string' || (activeCells.get(id) ?? 0) <= Date.now()) {
    throw new Error('browser-code-cell-cancelled')
  }
}
