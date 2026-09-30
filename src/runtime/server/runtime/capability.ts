import type { CapabilityImpl } from '@kernel/rpc/runtime'
import type { serverCapability } from '../contract'
import type { ServerHost } from './serverHost'

export interface ServerCapabilityDeps {
  host: ServerHost
  /** Servers run code from the workspace (section 9.2). */
  trust: { requireTrusted(): void }
}

export function serverCapabilityImpl({ host, trust }: ServerCapabilityDeps): CapabilityImpl<typeof serverCapability> {
  return {
    stop: ({ id }) => host.stop(id),
    async start(opts, sink) {
      trust.requireTrusted()
      const handle = await host.start(
        opts,
        (_id, stream, chunk) => sink.emit({ kind: 'output', stream, chunk }),
        (_id, code, signal) => sink.end({ code, signal }),
      )
      sink.emit({ kind: 'ready', ...handle })
      // Runs on cancel, and harmlessly after the server exited.
      return () => host.stop(handle.id)
    },
  }
}
