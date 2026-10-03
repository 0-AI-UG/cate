// IPC for the client transports and web partitions. A dial answers with a
// MessagePort posted to the calling renderer (one port per connection); the
// loopback web proxy asks a renderer for a loopback pipe the same way.

import { randomUUID } from 'node:crypto'
import { MessageChannelMain, session, type WebContents } from 'electron'
import type { ByteDuplex } from '@kernel/rpc/contract'
import { isLoopbackHostname } from '@runtime/tunnel/contract'
import { DESKTOP_CHANNELS as C, type DesktopNetworkTarget } from '../contract'
import { handle } from './ipc'
import { awaitPortPipe, bridgePipe } from './pipes'
import type { ShellTransportHost } from './transports'
import type { LoopbackDialer, WebPartitions } from './webPartitions'

function pipeId(value: unknown): string {
  if (typeof value !== 'string' || !/^[\w-]{1,64}$/.test(value)) throw new Error('invalid pipe id')
  return value
}

/** Hands a connected pipe to a renderer as a MessagePort. */
function deliver(contents: WebContents, pipe: string, duplex: ByteDuplex): void {
  if (contents.isDestroyed()) {
    duplex.close('window closed')
    return
  }
  const { port1, port2 } = new MessageChannelMain()
  // The port closes when the renderer goes; this is the fallback.
  const onGone = () => duplex.close('window closed')
  contents.once('destroyed', onGone)
  duplex.onClose(() => contents.removeListener('destroyed', onGone))
  bridgePipe(duplex, port1)
  contents.postMessage(C.pipePort, { pipe }, [port2])
}

const releasing = new WeakSet<WebContents>()

/** A renderer as the loopback dialer of the workspaces it serves. */
function rendererDialer(contents: WebContents): LoopbackDialer {
  return {
    id: contents.id,
    isDestroyed: () => contents.isDestroyed(),
    dial(runtimeId, port) {
      const { port1, port2 } = new MessageChannelMain()
      contents.postMessage(C.loopbackRequest, { runtimeId, port, pipe: randomUUID() }, [port2])
      return awaitPortPipe(port1)
    },
  }
}

export function registerTransportIpc(deps: { host: ShellTransportHost; partitions: WebPartitions }): void {
  const { host, partitions } = deps

  handle(C.dialLocal, async (event, pipe: unknown, root: unknown) => {
    const id = pipeId(pipe)
    if (typeof root !== 'string' || !root) throw new Error('no workspace root')
    deliver(event.sender, id, await host.dialLocal(root))
  })
  handle(C.dialNetwork, async (event, pipe: unknown, target: DesktopNetworkTarget) => {
    const id = pipeId(pipe)
    deliver(event.sender, id, await host.dialNetwork(target))
  })
  handle(C.dialLoopbackTcp, async (event, pipe: unknown, port: unknown) => {
    const id = pipeId(pipe)
    deliver(event.sender, id, await host.dialLoopbackTcp(Number(port)))
  })
  handle(C.pair, (_event, request: { link: string; deviceName?: string }) => {
    if (!request || typeof request.link !== 'string') throw new Error('no pairing link or code')
    return host.pair(request)
  })

  handle(C.webPartition, (event, workspace: { runtimeId: string }) => {
    const contents = event.sender
    if (!releasing.has(contents)) {
      releasing.add(contents)
      const id = contents.id
      contents.once('destroyed', () => partitions.releaseDialer(id))
    }
    return partitions.partitionFor(String(workspace?.runtimeId ?? ''), rendererDialer(contents))
  })
  handle(C.webRelease, (event, workspace: { runtimeId: string }) => {
    partitions.release(String(workspace?.runtimeId ?? ''), event.sender.id)
  })
  handle(C.webSetCookie, async (_event, partition: unknown, url: unknown, cookie: { name: string; value: string }) => {
    if (typeof partition !== 'string' || !partitions.isPrepared(partition)) throw new Error('not a workspace partition')
    const parsed = new URL(String(url))
    if (!/^https?:$/.test(parsed.protocol) || !isLoopbackHostname(parsed.hostname)) throw new Error('cookies are set only for loopback pages')
    if (typeof cookie?.name !== 'string' || typeof cookie.value !== 'string') throw new Error('invalid cookie')
    await session.fromPartition(partition).cookies.set({ url: parsed.origin, name: cookie.name, value: cookie.value })
  })
}
