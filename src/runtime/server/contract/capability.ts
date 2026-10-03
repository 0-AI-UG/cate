// The `server` host capability (architecture 7.9): long-lived HTTP children
// on a loopback port, reported ready only once they answer HTTP.

import { defineCapability, method, stream } from '@kernel/rpc/contract'

/** argv placeholders resolved by the runtime: its own Node and install dir. */
export const RUNTIME_NODE_EXECUTABLE = '$CATE_RUNTIME_NODE'
export const RUNTIME_INSTALL_ROOT_PLACEHOLDER = '$CATE_RUNTIME_INSTALL_ROOT'

export interface ServerStartOptions {
  /** argv; the first entry may be `RUNTIME_NODE_EXECUTABLE`. */
  command: string[]
  cwd: string
  env?: Record<string, string>
  /** The allocated loopback port is passed in this variable. */
  portEnv: string
  /** Polled until any HTTP response arrives. */
  readyPath: string
  readyTimeoutMs: number
  /** Written to stdin once, then stdin is closed. */
  bootstrapStdin?: string
  /** Put the bundled `cate` CLI on the child's PATH. */
  includeCateCli?: boolean
}

export interface ServerHandle {
  id: string
  pid: number
  /** Bound on 127.0.0.1 of the runtime's machine; reach it with `tunnel`. */
  port: number
}

export type ServerEvent =
  | ({ kind: 'ready' } & ServerHandle)
  | { kind: 'output'; stream: 'stdout' | 'stderr'; chunk: string }

export interface ServerExit {
  code: number | null
  signal: string | null
}

export const serverCapability = defineCapability('server', {
  methods: {
    stop: method<{ id: string }, void>({ mutates: true }),
  },
  streams: {
    /** Starts a server: `ready` once it answers, then its output; ends with
     *  its exit. Cancelling the stream stops the server. */
    start: stream<ServerStartOptions, ServerEvent, ServerExit>(),
  },
})

declare module '@kernel/rpc/contract' {
  interface CapabilityRegistry {
    server: typeof serverCapability
  }
}
