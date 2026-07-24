// Regression: WEBVIEW_SCREENSHOT must not pay a full-page base64 encode when the
// caller only wants the file. The CLI/agent screenshot path (browserDriver) uses
// only `filePath` and discards `dataUrl`, so it passes `{ wantDataUrl: false }`
// and the handler must skip `image.toDataURL()` entirely. The manual UI button
// (BrowserPanel) still consumes `dataUrl`, so the default keeps producing it.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Captured ipcMain.handle map so the test can invoke a handler directly.
const handlers = new Map<string, (...args: unknown[]) => unknown>()

// A single fake window id shared by caller + target so the ownership check passes.
const WIN_ID = 42

// Spies on the captured image so we can assert whether toDataURL was called.
const toPNG = vi.fn(() => Buffer.from('png-bytes'))
const toDataURL = vi.fn(() => 'data:image/png;base64,ZmFrZQ==')
const isEmpty = vi.fn(() => false)
const capturePage = vi.fn(async () => ({ isEmpty, toPNG, toDataURL }))

vi.mock('electron', () => ({
  app: { getPath: (name: string) => (name === 'temp' ? '/tmp' : '/desktop') },
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn)
    }),
  },
  nativeImage: { createFromPath: vi.fn(), createEmpty: vi.fn() },
  BrowserWindow: { fromWebContents: vi.fn(() => ({ id: WIN_ID })) },
  webContents: {
    fromId: vi.fn(() => ({ isDestroyed: () => false, capturePage })),
  },
}))

// Neighbor modules pull in heavy electron surfaces at import; stub them out.
vi.mock('../browserProxy', () => ({ configureBrowserProxy: vi.fn() }))
vi.mock('../../shared/runtimeLocator', () => ({ isLocalLocator: () => true }))
vi.mock('../windowRegistry', () => ({ windowFromEvent: vi.fn() }))
vi.mock('./pathValidation', () => ({
  validatePath: (p: string) => p,
  grantFileAccess: vi.fn(async (_windowId: number, p: string) => p),
}))

// Avoid touching the real filesystem for the PNG write.
const { writeFile, mkdir } = vi.hoisted(() => ({
  writeFile: vi.fn(async (..._a: unknown[]) => {}),
  mkdir: vi.fn(async (..._a: unknown[]) => undefined),
}))
vi.mock('fs', () => ({ default: { promises: { writeFile, mkdir } } }))

import { registerCaptureHandlers } from './capture'
import { WEBVIEW_SCREENSHOT } from '../../shared/ipc-channels'

registerCaptureHandlers()

const event = { sender: { id: WIN_ID } }

describe('WEBVIEW_SCREENSHOT dataUrl opt-out', () => {
  beforeEach(() => {
    toPNG.mockClear()
    toDataURL.mockClear()
  })

  it('skips toDataURL and omits dataUrl when wantDataUrl is false (CLI/agent path)', async () => {
    const handler = handlers.get(WEBVIEW_SCREENSHOT)!
    const result = (await handler(event, 7, { wantDataUrl: false })) as {
      filePath: string
      dataUrl?: string
    }
    expect(toDataURL).not.toHaveBeenCalled()
    expect(result.dataUrl).toBeUndefined()
    expect(result.filePath).toContain('screenshot-')
  })

  it('produces dataUrl by default (manual UI button path)', async () => {
    const handler = handlers.get(WEBVIEW_SCREENSHOT)!
    const result = (await handler(event, 7)) as { filePath: string; dataUrl?: string }
    expect(toDataURL).toHaveBeenCalledTimes(1)
    expect(result.dataUrl).toBe('data:image/png;base64,ZmFrZQ==')
    expect(result.filePath).toContain('screenshot-')
  })

  it('saves to a cate-screenshots temp dir when saveTo is temp (CLI/agent path)', async () => {
    const handler = handlers.get(WEBVIEW_SCREENSHOT)!
    const result = (await handler(event, 7, { wantDataUrl: false, saveTo: 'temp' })) as { filePath: string }
    expect(result.filePath.replace(/\\/g, '/')).toContain('/tmp/cate-screenshots/screenshot-')
    expect(mkdir).toHaveBeenCalled()
  })

  it('keeps the Desktop for the default (manual) path', async () => {
    const handler = handlers.get(WEBVIEW_SCREENSHOT)!
    const result = (await handler(event, 7)) as { filePath: string }
    expect(result.filePath.replace(/\\/g, '/')).toContain('/desktop/screenshot-')
  })
})
