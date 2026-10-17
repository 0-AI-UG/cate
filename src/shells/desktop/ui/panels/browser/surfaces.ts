// Page operations for this workspace's browser panels, when this client has
// `pageDriver` (architecture 10.2): `page.*` runs on the page the panel's
// mounted view has ready (`BrowserPageHost`, registered with the client
// host's surface registry, which mounts a view on demand) through the page
// ops; `code.*` runs in this client's code session and is the workspace's
// panel-less surface.

import { registerSurface } from '@client/host'
import { RpcError, type CapabilityProxy } from '@kernel/rpc/contract'
import type { SurfaceRequest } from '@panels/framework/contract'
import type { BrowserPageBridge, BrowserSurfaceArgs, BrowserSurfaceOp, browserCodeCapability } from '@services/browser/contract'
import type { PageOps } from '@services/browser/desktop/renderer'
import type { BrowserPageHost } from '@panels/browser/desktop'

/** Running cells and the runtime each one's `cua.*` calls go back to. */
const cellOwners = new Map<string, CapabilityProxy<typeof browserCodeCapability>>()
const codeCallBridges = new WeakSet<BrowserPageBridge>()

function routeCodeCalls(bridge: BrowserPageBridge): void {
  if (codeCallBridges.has(bridge)) return
  codeCallBridges.add(bridge)
  bridge.onCodeCall(async (call) => {
    const owner = cellOwners.get(call.cellId)
    if (!owner) throw new Error('browser-code-cell-cancelled')
    return owner.call({ cellId: call.cellId, method: call.method, args: call.args })
  })
}

export interface PageOpDeps {
  host: BrowserPageHost
  ops: PageOps
  /** Asks the person (through `ClientUi`). */
  confirm(message: string): Promise<boolean>
}

/** Runs a `page.*` operation on a mounted browser view. */
export async function runPageOp({ host, ops, confirm }: PageOpDeps, request: SurfaceRequest): Promise<unknown> {
  switch (request.op as BrowserSurfaceOp) {
    case 'page.ready': return host.ready(request.args as BrowserSurfaceArgs<'page.ready'>)
    case 'page.history': return host.history(request.args as BrowserSurfaceArgs<'page.history'>)
    case 'page.execute': {
      const { tabId, method, args, settle } = request.args as BrowserSurfaceArgs<'page.execute'>
      return ops.execute(await host.target(tabId, settle), method, args)
    }
    case 'page.download': {
      const { tabId, url } = request.args as BrowserSurfaceArgs<'page.download'>
      await ops.download(await host.target(tabId), url)
      return { url }
    }
    case 'page.confirm': return { ok: await confirm((request.args as BrowserSurfaceArgs<'page.confirm'>).message) }
    default: throw new RpcError('unsupported', `unknown page operation ${request.op}`)
  }
}

/** Runs a `code.*` operation in this client's code session. */
export async function runCodeOp(deps: { browserCode: CapabilityProxy<typeof browserCodeCapability>; bridge: BrowserPageBridge }, request: SurfaceRequest): Promise<unknown> {
  const op = request.op as BrowserSurfaceOp
  if (op === 'code.run') {
    const args = request.args as BrowserSurfaceArgs<'code.run'>
    routeCodeCalls(deps.bridge)
    cellOwners.set(args.cellId, deps.browserCode)
    try {
      return await deps.bridge.runCode(args)
    } finally {
      cellOwners.delete(args.cellId)
    }
  }
  if (op === 'code.reset') {
    await deps.bridge.resetCode((request.args as BrowserSurfaceArgs<'code.reset'>).key)
    return undefined
  }
  throw new RpcError('unsupported', `unknown browser code operation ${request.op}`)
}

/** Serves a workspace's browser code cells on this client. */
export function serveBrowserCode(workspaceId: string, deps: { browserCode: CapabilityProxy<typeof browserCodeCapability>; bridge: BrowserPageBridge }): () => void {
  return registerSurface(workspaceId, null, (request) => runCodeOp(deps, request))
}
