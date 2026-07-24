import { afterEach, describe, expect, test } from 'vitest'
import { runtimes } from './runtimeManager'
import { parseLocator, LOCAL_RUNTIME_ID } from '../../shared/runtimeLocator'
import type { Runtime, FileHost, VcsHost, ProcessHost, AgentHost, ServerHost, TunnelHost } from './types'

// Prove the decode-and-dispatch layer routes a `cate-runtime://` URI to a
// registered (non-local) runtime, while bare local paths still parse to the
// LOCAL runtime id. This is exactly what every IPC handler does:
//   const { runtimeId, path } = parseLocator(raw)
//   runtimes.resolve(runtimeId).file.readFile(path)

function makeStub(id: string, calls: string[]): Runtime {
  const file = {
    readFile: async (p: string) => {
      calls.push(`readFile:${p}`)
      return 'stub-contents'
    },
  } as unknown as FileHost
  const vcs = {} as VcsHost
  return {
    id,
    process: {} as unknown as ProcessHost,
    agent: {} as unknown as AgentHost,
    agentHooks: { subscribe: () => () => {}, inspectWorkspace: async () => [] },
    file,
    vcs,
    server: {} as unknown as ServerHost,
    tunnel: {} as unknown as TunnelHost,
    validatePath: (p) => p,
    validatePathStrict: async (p) => p,
    validatePathForCreation: async (p) => p,
    validateCwd: (p) => p,
    addAllowedRoot: async () => {},
    removeAllowedRoot: async () => {},
    setExclusions: async () => {},
    setIdleSuspend: async () => {},
    grantFileAccess: async () => {},
    registerScopedWriteAllowance: async () => {},
    clearFileGrantsForWindow: async () => {},
    clearScopedWriteAllowancesForWindow: async () => {},
  }
}

describe('runtime dispatch', () => {
  afterEach(() => {
    runtimes.unregister('srv_test')
  })

  test('a cate-runtime:// path resolves to the registered runtime and forwards the decoded path', async () => {
    const calls: string[] = []
    runtimes.register(makeStub('srv_test', calls))

    const raw = 'cate-runtime://srv_test/home/me/proj/file.ts'
    const { runtimeId, path } = parseLocator(raw)
    expect(runtimeId).toBe('srv_test')

    const runtime = runtimes.resolve(runtimeId)
    const safe = await runtime.validatePathStrict(path)
    const contents = await runtime.file.readFile(safe)

    expect(contents).toBe('stub-contents')
    // The runtime received the DECODED remote path, never the URI.
    expect(calls).toEqual(['readFile:/home/me/proj/file.ts'])
  })

  test('a bare local path parses to the LOCAL runtime id', () => {
    const { runtimeId } = parseLocator('/Users/anton/proj/file.ts')
    expect(runtimeId).toBe(LOCAL_RUNTIME_ID)
    // The LOCAL runtime is the daemon subprocess, provisioned at startup by
    // ensureLocalRuntime — it isn't registered in this unit-test context, so
    // resolve() throws until it's online. (parseLocator routing is what matters here.)
    expect(() => runtimes.resolve(runtimeId)).toThrow(/No runtime registered/)
  })

  test('the local runtime cannot be replaced', () => {
    expect(() => runtimes.register(makeStub(LOCAL_RUNTIME_ID, []))).toThrow(/built in/)
  })
})
