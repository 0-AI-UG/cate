import type { CapabilityImpl } from '@kernel/rpc/runtime'
import type { processCapability } from '../contract'
import type { TerminalService } from './terminalService'

/** Serves a TerminalService as the `process` capability. */
export function processCapabilityImpl(service: TerminalService): CapabilityImpl<typeof processCapability> {
  return {
    spawn: (params) => service.spawn(params),
    write: ({ id, data }) => service.write(id, data),
    view: (params) => service.view(params),
    kill: ({ id }) => service.kill(id),
    close: ({ id }) => service.close(id),
    cwd: ({ id }) => service.cwd(id),
    read: ({ id, lines }) => service.read(id, lines),
    snapshot: ({ id }) => service.snapshot(id),
    list: () => service.list(),
    attach: (params, sink) => service.attach(params, sink),
    statuses: (_params, sink) => {
      let rev = 0
      sink.emit({ kind: 'snapshot', rev, snapshot: service.statuses() })
      return service.onStatusChange((change) => sink.emit({ kind: 'change', rev: ++rev, change }))
    },
  }
}
