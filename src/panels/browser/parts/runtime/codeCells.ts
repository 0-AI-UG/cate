// Live `cate.browser.run` cells in the runtime. The client running a cell
// sends its `cua.*` calls back through `browserCode.call`; each runs as the
// cell's caller (`ctx.invoke`), so the same gates apply, only while the cell
// is live, and only on the cell's one browser panel.

import { RpcError } from '@kernel/rpc/contract'
import type { CapabilityImpl } from '@kernel/rpc/runtime'
import { BROWSER_METHODS } from '@services/browser/contract'
import type { browserCodeCapability } from '../../contract'

/** A cell knows tabs, not panels: results lose the panel id. */
function withoutPanel(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const { panelId: _panel, ...rest } = value as Record<string, unknown>
  if (rest.observation) rest.observation = withoutPanel(rest.observation)
  if (Array.isArray(rest.tabs)) rest.tabs = rest.tabs.map(withoutPanel)
  return rest
}

/** Methods that act on a bound tab; they carry the cell id to the driver. */
const PAGE_METHODS = new Set([...BROWSER_METHODS].filter((name) => !['listTabs', 'getTab', 'createTab'].includes(name)))

interface Cell {
  deadline: number
  /** The browser panel the cell drives; it reaches no other. */
  panelId: string
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
    if (panelId !== undefined) {
      throw new RpcError('rejected', 'browser-code-panel: code works on the tabs of one browser panel, chosen on the command line (cate browser run --panel <id>).')
    }
    const callArgs: Record<string, unknown> = PAGE_METHODS.has(method) ? { ...rest, _codeCellId: cellId } : rest
    return withoutPanel(await cell.invoke(`cate.browser.${method}`, { ...callArgs, panelId: cell.panelId }))
  }
}

export function browserCodeCapabilityImpl(cells: BrowserCodeCells): CapabilityImpl<typeof browserCodeCapability> {
  return {
    call: ({ cellId, method, args }) => cells.call(cellId, method, args && typeof args === 'object' ? args : {}),
  }
}
