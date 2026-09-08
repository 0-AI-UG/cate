import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  validatePathStrict: vi.fn(),
  stat: vi.fn(),
}))

vi.mock('../ipc/pathValidation', () => ({ validatePathStrict: mocks.validatePathStrict }))
vi.mock('node:fs/promises', () => ({ default: { stat: mocks.stat } }))

import { authorizeBrowserUpload } from './browserUpload'

describe('authorizeBrowserUpload', () => {
  beforeEach(() => vi.clearAllMocks())

  it('passes only the canonical authorized file to the runtime', async () => {
    mocks.validatePathStrict.mockResolvedValue('/safe/report.pdf')
    mocks.stat.mockResolvedValue({ isFile: () => true })

    await expect(authorizeBrowserUpload(
      '../report.pdf', 7, 'workspace-1',
    )).resolves.toEqual('/safe/report.pdf')
    expect(mocks.validatePathStrict).toHaveBeenCalledWith('../report.pdf', 7, 'workspace-1')
  })

  it('hides denied host paths behind a stable error', async () => {
    mocks.validatePathStrict.mockRejectedValue(new Error('Access denied: /secret'))
    await expect(authorizeBrowserUpload(
      '/secret', 7, 'workspace-1',
    )).rejects.toThrow('browser-upload-path-denied')
  })

  it('rejects directories', async () => {
    mocks.validatePathStrict.mockResolvedValue('/safe/folder')
    mocks.stat.mockResolvedValue({ isFile: () => false })
    await expect(authorizeBrowserUpload(
      '/safe/folder', 7, 'workspace-1',
    )).rejects.toThrow('browser-upload-file-required')
  })
})
