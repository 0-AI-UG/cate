// Page operations for this workspace's browser panels, when this client has
// `pageDriver` (architecture 10.2): `page.*` runs on the page the panel's
// mounted view has ready (`BrowserPageHost`, registered with the client
// host's surface registry, which mounts a view on demand) through the page
// ops.

import { RpcError } from '@kernel/rpc/contract'
import type { SurfaceRequest } from '@panels/framework/contract'
import type { BrowserSurfaceArgs, BrowserSurfaceOp } from '@services/browser/contract'
import type { PageOps } from '@services/browser/desktop/renderer'
import type { BrowserPageHost } from '@panels/browser/desktop'

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
