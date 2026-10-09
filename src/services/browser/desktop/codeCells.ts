// Code cell authority on this client. A cell's id travels with each page call
// it makes; ending the cell cancels its queued work here, and checking the
// deadline also covers a delayed timer. A page call may arrive from a cell run
// by another client: the runtime vouches for those (`browserCode.call`), so an
// id this client never saw passes.

const ENDED_KEPT = 1_000

export class CodeCellRegistry {
  private readonly active = new Map<string, number>()
  private readonly ended = new Set<string>()

  constructor(private readonly now: () => number = Date.now) {}

  begin(id: string, deadline: number): void {
    this.ended.delete(id)
    this.active.set(id, deadline)
  }

  end(id: string): void {
    if (!this.active.delete(id)) return
    this.ended.add(id)
    if (this.ended.size > ENDED_KEPT) this.ended.delete(this.ended.values().next().value!)
  }

  /** Passes calls outside a cell (no id) and cells this client never ran. */
  assert = (id: unknown): void => {
    if (id === undefined) return
    if (typeof id !== 'string') throw new Error('browser-code-cell-cancelled')
    const deadline = this.active.get(id)
    if (this.ended.has(id) || (deadline !== undefined && deadline <= this.now())) throw new Error('browser-code-cell-cancelled')
  }
}
