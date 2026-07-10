import { buildDaemonRuntime } from '../../runtime/capabilities'
import { LOCAL_RUNTIME_ID } from './locator'
import type { Runtime } from './types'
import { runtimes } from './runtimeManager'

/** Register the production daemon capability assembly in-process for IPC tests. */
export function registerTestDaemonRuntime(exclusions: string[] = []): Runtime {
  const runtime = buildDaemonRuntime({ id: LOCAL_RUNTIME_ID, exclusions }).runtime
  runtimes.registerLocalForTest(runtime)
  return runtime
}
