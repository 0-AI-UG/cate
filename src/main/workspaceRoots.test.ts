import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { afterEach, describe, expect, test, vi } from 'vitest'

vi.mock('./logger', () => ({ default: { warn: vi.fn() } }))

import { resolveTrustedWorkspaceRoot } from './workspaceRoots'

const tempDirs: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

describe('resolveTrustedWorkspaceRoot', () => {
  test('falls back to the JS realpath implementation for WinFsp-style native failures', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cate-workspace-root-'))
    tempDirs.push(root)
    vi.spyOn(fs, 'realpath').mockRejectedValueOnce(
      Object.assign(new Error('unknown realpath error'), { code: 'UNKNOWN' }),
    )

    await expect(resolveTrustedWorkspaceRoot(root)).resolves.toBe(path.resolve(root))
  })

  test('preserves the selected path form after validating its canonical alias', async () => {
    const selected = path.resolve('/mapped-drive/project')
    vi.spyOn(fs, 'realpath').mockResolvedValue('/server/share/project')
    vi.spyOn(fs, 'stat').mockResolvedValue({ isDirectory: () => true } as Awaited<ReturnType<typeof fs.stat>>)

    await expect(resolveTrustedWorkspaceRoot(selected)).resolves.toBe(selected)
  })
})
