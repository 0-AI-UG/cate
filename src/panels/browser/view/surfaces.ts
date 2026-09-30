// Page operations for the browser panels of one workspace, when this client
// has `pageDriver` (architecture 10.2). The runtime sends each request to the
// driving client; it runs on the panel's mounted view (`BrowserPageHost`), or
// in this client's code session for `code.*`.
//
// The panel must be mounted here. Mounting one on demand belongs to the client
// host's surface registry: `onSurfaceDemand` tells it which panel a request is
// waiting for; the request fails with `no-renderer` if no view appears.

import { serveSurfaceRequests } from '@panels/framework/client'
import { RpcError, type CapabilityProxy } from '@kernel/rpc/contract'
import type { SurfaceRequest, surfaceCapability } from '@panels/framework/contract'
import type { BrowserPageBridge } from '@services/browser/contract'
import type { BrowserSurfaceArgs, BrowserSurfaceOp, browserCodeCapability } from '../contract'
import type { BrowserPageHost } from './pageHost'

const MOUNT_WAIT_MS = 5_000

/** Mounted browser views on this client, keyed by `workspaceId:panelId`.
 *  A stable key for now; the client host's surface registry replaces it. */
const hosts = new Map<string, BrowserPageHost>()
const hostWaiters = new Set<() => void>()
const demandListeners = new Set<(demand: { workspaceId: string; panelId: string; active: boolean }) => void>()

const keyOf = (workspaceId: string, panelId: string) => `${workspaceId}:${panelId}`

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

export function registerPageHost(workspaceId: string, host: BrowserPageHost): () => void {
  const key = keyOf(workspaceId, host.panelId)
  hosts.set(key, host)
  for (const waiter of [...hostWaiters]) waiter()
  return () => { if (hosts.get(key) === host) hosts.delete(key) }
}

export function pageHostFor(workspaceId: string, panelId: string): BrowserPageHost | undefined {
  return hosts.get(keyOf(workspaceId, panelId))
}

/** Which panel a page operation is waiting to have mounted on this client. */
export function onSurfaceDemand(listener: (demand: { workspaceId: string; panelId: string; active: boolean }) => void): () => void {
  demandListeners.add(listener)
  return () => { demandListeners.delete(listener) }
}

async function mountedHost(workspaceId: string, panelId: string): Promise<BrowserPageHost> {
  const existing = pageHostFor(workspaceId, panelId)
  if (existing) return existing
  const demand = (active: boolean) => { for (const listener of [...demandListeners]) listener({ workspaceId, panelId, active }) }
  demand(true)
  try {
    return await new Promise<BrowserPageHost>((resolve, reject) => {
      const check = () => {
        const host = pageHostFor(workspaceId, panelId)
        if (!host) return
        clearTimeout(timer)
        hostWaiters.delete(check)
        resolve(host)
      }
      const timer = setTimeout(() => {
        hostWaiters.delete(check)
        reject(new RpcError('no-renderer', 'The browser panel is not open on the driving client'))
      }, MOUNT_WAIT_MS)
      hostWaiters.add(check)
    })
  } finally {
    demand(false)
  }
}

export interface BrowserSurfaceDeps {
  workspaceId: string
  surface: CapabilityProxy<typeof surfaceCapability>
  browserCode: CapabilityProxy<typeof browserCodeCapability>
  bridge: BrowserPageBridge
}

/** Runs one request. Exported for tests; `serveBrowserSurfaces` wires it. */
export async function runBrowserSurfaceRequest(deps: Omit<BrowserSurfaceDeps, 'surface'>, request: SurfaceRequest): Promise<unknown> {
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
  const host = await mountedHost(deps.workspaceId, request.panelId)
  switch (op) {
    case 'page.ready': return host.ready(request.args as BrowserSurfaceArgs<'page.ready'>)
    case 'page.history': return host.history(request.args as BrowserSurfaceArgs<'page.history'>)
    case 'page.execute': return host.execute(request.args as BrowserSurfaceArgs<'page.execute'>)
    case 'page.download': return host.download(request.args as BrowserSurfaceArgs<'page.download'>)
    default: throw new RpcError('unsupported', `unknown page operation ${request.op}`)
  }
}

/** Answers the runtime's page operations for this workspace's browser panels.
 *  The client calls it once per connection when it declares `pageDriver`. */
export function serveBrowserSurfaces(deps: BrowserSurfaceDeps): () => void {
  return serveSurfaceRequests(deps.surface, (request) => runBrowserSurfaceRequest(deps, request))
}
