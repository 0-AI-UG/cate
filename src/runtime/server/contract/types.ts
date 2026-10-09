// Long-lived HTTP children on a loopback port, reported ready only once they
// answer HTTP (architecture 7.9). Runtime modules start them through the
// server host (T3); no client can.

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
