import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getAppPath: () => process.cwd() },
}))
vi.mock('./codingDir', () => ({
  hostCodingDir: () => '/host/.cate/cate-agent',
  hostJoin: (_runtimeId: string, ...segments: string[]) => segments.join('/'),
}))
vi.mock('../../main/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn() },
}))

import { installSubagentExtension } from './installSubagent'

describe('installSubagentExtension', () => {
  it('installs the subagent tool and Cate-owned scout, planner, and worker', async () => {
    const runtime = {
      id: 'local',
      file: {
        stat: vi.fn(async () => { throw new Error('missing') }),
        readFile: vi.fn(),
        mkdir: vi.fn(async () => undefined),
        writeFile: vi.fn(async () => undefined),
        remove: vi.fn(async () => undefined),
      },
    } as any

    await installSubagentExtension(runtime, '/repo')

    const writes = new Map(
      runtime.file.writeFile.mock.calls.map((call: unknown[]) => [call[0], call[1]]),
    )
    expect(Array.from(writes.keys())).toEqual([
      '/host/.cate/cate-agent/extensions/cate-subagent/index.ts',
      '/host/.cate/cate-agent/extensions/cate-subagent/agents.ts',
      '/host/.cate/cate-agent/agents/scout.md',
      '/host/.cate/cate-agent/agents/planner.md',
      '/host/.cate/cate-agent/agents/worker.md',
    ])
    expect(writes.get('/host/.cate/cate-agent/extensions/cate-subagent/index.ts'))
      .toContain('name: "subagent"')
    expect(writes.get('/host/.cate/cate-agent/agents/scout.md'))
      .toContain('tools: read, grep, find, ls')
    expect(writes.get('/host/.cate/cate-agent/agents/scout.md'))
      .not.toContain('model:')
    expect(writes.get('/host/.cate/cate-agent/agents/planner.md'))
      .toContain('tools: read, grep, find, ls')
    expect(writes.get('/host/.cate/cate-agent/agents/worker.md'))
      .toContain('tools: read, write, edit, bash, grep, find, ls')
    expect(writes.get('/host/.cate/cate-agent/agents/worker.md'))
      .not.toContain('tools: subagent')
  })

  it('removes the legacy Cate-managed extension before installing the renamed one', async () => {
    const legacyDir = '/host/.cate/cate-agent/extensions/subagent'
    const runtime = {
      id: 'legacy-local',
      file: {
        stat: vi.fn(async (filePath: string) => {
          if (filePath === legacyDir) return { isDirectory: true, isFile: false }
          throw new Error('missing')
        }),
        readFile: vi.fn(),
        mkdir: vi.fn(async () => undefined),
        writeFile: vi.fn(async () => undefined),
        remove: vi.fn(async () => undefined),
      },
    } as any

    await installSubagentExtension(runtime, '/repo')

    expect(runtime.file.remove).toHaveBeenCalledWith(legacyDir)
    expect(runtime.file.remove.mock.invocationCallOrder[0]).toBeLessThan(
      runtime.file.writeFile.mock.invocationCallOrder[0],
    )
  })

  it('does not start a Cate Agent session without the required subagent runtime', async () => {
    const failure = new Error('remote write failed')
    const runtime = {
      id: 'broken-remote',
      file: {
        stat: vi.fn(async () => { throw new Error('missing') }),
        readFile: vi.fn(),
        mkdir: vi.fn(async () => undefined),
        writeFile: vi.fn(async () => { throw failure }),
        remove: vi.fn(async () => undefined),
      },
    } as any

    await expect(installSubagentExtension(runtime, '/repo')).rejects.toBe(failure)
  })
})
