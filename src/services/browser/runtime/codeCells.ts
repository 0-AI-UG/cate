// `cate.browser.run` cells in the runtime: `run` and `reset` (the service
// half of `cate.browser.*`) and the live cells. A cell runs in the code
// session of the driving client of its one browser panel; that client sends
// its `cua.*` calls back through `browserCode.call`, and each runs as the
// cell's caller (`ctx.invoke`), so the same gates apply, only while the cell
// is live, and only on the cell's one browser panel.

import { RpcError, isRpcError } from '@kernel/rpc/contract'
import type { CapabilityImpl } from '@kernel/rpc/runtime'
import type { CateServiceHandlers } from '@kernel/api/contract'
import { BROWSER_CODE_TIMEOUT_MS, type browserApi } from '../contract/api'
import { BROWSER_METHODS, type BrowserCodeResult } from '../contract/automation'
import type { browserCodeCapability } from '../contract/codeCapability'
import { BROWSER_SURFACE_FEATURES, type BrowserSurfaceArgs } from '../contract/surface'

/** A cell's own deadline; the router's is `BROWSER_CODE_TIMEOUT_MS`, a little longer. */
export const BROWSER_CELL_DEADLINE_MS = 30_000

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

export interface BrowserCodeDeps {
  /** The surface broker: `code.*` runs on the driving client of the panel `near`. */
  surfaces: {
    request(panelId: null, op: string, args: unknown, options: { feature: 'pageDriver'; near?: string; timeoutMs?: number; signal?: AbortSignal }): Promise<unknown>
  }
  cells: BrowserCodeCells
  newId?: () => string
  now?: () => number
}

const text = (message: string): BrowserCodeResult => ({ content: [{ type: 'text', text: message }], isError: true })

/** `cate.browser.run` and `reset`. */
export function browserCodeHandlers(deps: BrowserCodeDeps): Pick<CateServiceHandlers<typeof browserApi>, 'run' | 'reset'> {
  const newId = deps.newId ?? (() => globalThis.crypto.randomUUID())
  const now = deps.now ?? Date.now
  const request = <Op extends 'code.run' | 'code.reset'>(op: Op, args: BrowserSurfaceArgs<Op>, options: { near?: string; timeoutMs?: number; signal?: AbortSignal }) =>
    deps.surfaces.request(null, op, args, { ...options, feature: BROWSER_SURFACE_FEATURES[op] })

  return {
    run: async ({ code, panelId }, ctx) => {
      // A cell drives one browser panel: the named one, or the one a command
      // without --panel would target. It runs on that panel's driving client.
      const target = panelId ?? ctx.defaultTarget('browser')
      if (!target) return text('No browser panel to run in. Create one with `cate panel create browser [url]`, or pass --panel <id>.')
      const cellId = newId()
      deps.cells.begin(cellId, { deadline: now() + BROWSER_CELL_DEADLINE_MS, panelId: target, invoke: ctx.invoke })
      try {
        return await request('code.run', { key: ctx.caller.id, cellId, code, deadlineMs: BROWSER_CELL_DEADLINE_MS }, {
          timeoutMs: BROWSER_CODE_TIMEOUT_MS - 2_000,
          signal: ctx.signal,
          near: target,
        })
      } catch (err) {
        if (isRpcError(err, 'timeout')) void request('code.reset', { key: ctx.caller.id }, { near: target }).catch(() => {})
        if (isRpcError(err, 'no-renderer')) return text('No connected client can run browser code')
        return text(err instanceof Error ? err.message : String(err))
      } finally {
        deps.cells.end(cellId)
      }
    },
    reset: async (_args, ctx) => {
      const target = ctx.defaultTarget('browser') ?? undefined
      try {
        await request('code.reset', { key: ctx.caller.id }, { near: target })
      } catch (err) {
        if (!isRpcError(err, 'no-renderer')) throw err
      }
      return { content: [{ type: 'text', text: 'Browser code session reset' }] } satisfies BrowserCodeResult
    },
  }
}
