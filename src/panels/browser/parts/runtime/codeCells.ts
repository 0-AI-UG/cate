// Live `cate.browser.run` cells in the runtime. The client running a cell
// sends its `cua.*` calls back through `browserCode.call`; each runs as the
// cell's caller (`ctx.invoke`), so the same gates apply, and only while the
// cell is live.

import { RpcError } from '@kernel/rpc/contract'
import type { CapabilityImpl } from '@kernel/rpc/runtime'
import { BROWSER_METHODS } from '@services/browser/contract'
import type { browserCodeCapability } from '../../contract'

/** Methods that act on a bound tab; they carry the cell id to the driver. */
const PAGE_METHODS = new Set([...BROWSER_METHODS].filter((name) => !['listTabs', 'getTab', 'createTab'].includes(name)))

interface Cell {
  deadline: number
  invoke(method: string, args?: Record<string, unknown>): Promise<unknown>
}

export class BrowserCodeCells {
  private readonly cells = new Map<string, Cell>()

  constructor(private readonly now: () => number = Date.now) {}

  begin(id: string, cell: Cell): void {
    this.cells.set(id, cell)
  }

  end(id: string): void {
    this.cells.delete(id)
  }

  isLive(id: string): boolean {
    const cell = this.cells.get(id)
    return !!cell && cell.deadline > this.now()
  }

  async call(cellId: string, method: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const cell = this.cells.get(cellId)
    if (!cell || cell.deadline <= this.now()) throw new RpcError('rejected', 'browser-code-cell-cancelled')
    if (typeof method !== 'string' || !BROWSER_METHODS.has(method)) throw new RpcError('rejected', 'Unsupported browser method')
    // The runtime decides which calls carry the cell id; the caller's copy
    // (the client's code session tags every call) is dropped.
    const { panelId, _codeCellId: _ignored, ...rest } = args
    const callArgs: Record<string, unknown> = PAGE_METHODS.has(method) ? { ...rest, _codeCellId: cellId } : rest
    if (typeof panelId === 'string') callArgs.panelId = panelId
    return cell.invoke(`cate.browser.${method}`, callArgs)
  }
}

export function browserCodeCapabilityImpl(cells: BrowserCodeCells): CapabilityImpl<typeof browserCodeCapability> {
  return {
    call: ({ cellId, method, args }) => cells.call(cellId, method, args && typeof args === 'object' ? args : {}),
  }
}
