import { beforeEach, describe, expect, it, vi } from 'vitest'

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

import { createBundledExtensionInstaller } from './extensionInstall'

function runtime(writeFile = vi.fn(async () => undefined)) {
  return {
    id: 'local',
    file: {
      stat: vi.fn(async () => { throw new Error('missing') }),
      readFile: vi.fn(),
      mkdir: vi.fn(async () => undefined),
      writeFile,
    },
  } as any
}

describe('createBundledExtensionInstaller', () => {
  beforeEach(() => vi.clearAllMocks())

  it('shares concurrent work and skips a completed install', async () => {
    const host = runtime()
    const install = createBundledExtensionInstaller('cate-plan-mode', '[test]')

    await Promise.all([install(host, '/repo'), install(host, '/repo')])
    await install(host, '/repo')

    expect(host.file.writeFile).toHaveBeenCalledTimes(2)
    expect(host.file.writeFile.mock.calls.map((call: unknown[]) => call[0])).toEqual([
      '/host/.cate/cate-agent/extensions/cate-plan-mode/index.ts',
      '/host/.cate/cate-agent/extensions/cate-plan-mode/package.json',
    ])
  })

  it('does not poison the install-once cache after a transient write failure', async () => {
    const writeFile = vi.fn()
      .mockRejectedValueOnce(new Error('remote disconnected'))
      .mockResolvedValue(undefined)
    const host = runtime(writeFile)
    const install = createBundledExtensionInstaller('cate-plan-mode', '[test]')

    await install(host, '/repo')
    await install(host, '/repo')

    expect(writeFile).toHaveBeenCalledTimes(3)
  })
})
