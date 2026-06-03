import { afterEach, describe, expect, test } from 'vitest'
import { companions } from './companionManager'
import { parseLocator, LOCAL_COMPANION_ID } from './locator'
import type { Companion, FileHost, VcsHost, ProcessHost, AgentHost } from './types'

// Prove the decode-and-dispatch layer routes a `cate-companion://` URI to a
// registered (non-local) companion, while bare local paths still parse to the
// LOCAL companion id. This is exactly what every IPC handler does:
//   const { companionId, path } = parseLocator(raw)
//   companions.resolve(companionId).file.readFile(path)

function makeStub(id: string, calls: string[]): Companion {
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
    file,
    vcs,
    validatePath: (p) => p,
    validatePathStrict: async (p) => p,
    validatePathForCreation: async (p) => p,
    validateCwd: (p) => p,
    addAllowedRoot: async () => {},
    removeAllowedRoot: async () => {},
  }
}

describe('companion dispatch', () => {
  afterEach(() => {
    companions.unregister('srv_test')
  })

  test('a cate-companion:// path resolves to the registered companion and forwards the decoded path', async () => {
    const calls: string[] = []
    companions.register(makeStub('srv_test', calls))

    const raw = 'cate-companion://srv_test/home/me/proj/file.ts'
    const { companionId, path } = parseLocator(raw)
    expect(companionId).toBe('srv_test')

    const companion = companions.resolve(companionId)
    const safe = await companion.validatePathStrict(path)
    const contents = await companion.file.readFile(safe)

    expect(contents).toBe('stub-contents')
    // The companion received the DECODED remote path, never the URI.
    expect(calls).toEqual(['readFile:/home/me/proj/file.ts'])
  })

  test('a bare local path parses to the LOCAL companion id', () => {
    const { companionId } = parseLocator('/Users/anton/proj/file.ts')
    expect(companionId).toBe(LOCAL_COMPANION_ID)
    // The LOCAL companion is the daemon subprocess, provisioned at startup by
    // ensureLocalCompanion — it isn't registered in this unit-test context, so
    // resolve() throws until it's online. (parseLocator routing is what matters here.)
    expect(() => companions.resolve(companionId)).toThrow(/No companion registered/)
  })

  test('the local companion cannot be replaced', () => {
    expect(() => companions.register(makeStub(LOCAL_COMPANION_ID, []))).toThrow(/built in/)
  })
})
