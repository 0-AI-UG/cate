import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  outputBitmap: Buffer.alloc(0),
  createFromBitmap: vi.fn(),
}))

vi.mock('electron', () => ({
  nativeImage: {
    createFromBuffer: vi.fn((bytes: Buffer) => {
      const channel = bytes.toString() === 'top' ? 1 : 2
      return {
        isEmpty: () => false,
        getSize: () => ({ width: 2, height: 2 }),
        toBitmap: () => Buffer.from([
          channel, channel, channel, 255,
          channel, channel, channel, 255,
          channel, channel, channel, 255,
          channel, channel, channel, 255,
        ]),
      }
    }),
    createFromBitmap: h.createFromBitmap,
  },
}))

import { captureFullPageScreenshot } from './fullPageScreenshot'

describe('captureFullPageScreenshot', () => {
  beforeEach(() => {
    h.outputBitmap = Buffer.alloc(0)
    h.createFromBitmap.mockReset()
    h.createFromBitmap.mockImplementation((bitmap: Buffer) => {
      h.outputBitmap = Buffer.from(bitmap)
      return { toPNG: () => Buffer.from('stitched-png') }
    })
  })

  it('captures painted viewport tiles instead of asking Chromium for one beyond-viewport surface', async () => {
    const executeJavaScript = vi.fn()
      .mockResolvedValueOnce({
        width: 2,
        height: 4,
        viewportWidth: 2,
        viewportHeight: 2,
        scrollX: 0,
        scrollY: 0,
      })
      .mockResolvedValueOnce({ x: 0, y: 0 })
      .mockResolvedValueOnce({ x: 0, y: 2 })
      .mockResolvedValueOnce({ x: 0, y: 0 })
    const sendCommand = vi.fn()
      .mockResolvedValueOnce({ data: Buffer.from('top').toString('base64') })
      .mockResolvedValueOnce({ data: Buffer.from('bottom').toString('base64') })
    const wc = {
      executeJavaScript,
      debugger: { sendCommand },
      invalidate: vi.fn(),
    } as unknown as Electron.WebContents

    await expect(captureFullPageScreenshot(wc)).resolves.toEqual(Buffer.from('stitched-png'))

    expect(sendCommand).toHaveBeenCalledTimes(2)
    expect(sendCommand).toHaveBeenCalledWith('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: false,
    })
    expect(h.createFromBitmap).toHaveBeenCalledWith(expect.any(Buffer), { width: 2, height: 4 })
    expect([...h.outputBitmap.subarray(0, 16)]).toEqual([
      1, 1, 1, 255, 1, 1, 1, 255,
      1, 1, 1, 255, 1, 1, 1, 255,
    ])
    expect([...h.outputBitmap.subarray(16)]).toEqual([
      2, 2, 2, 255, 2, 2, 2, 255,
      2, 2, 2, 255, 2, 2, 2, 255,
    ])
    expect(executeJavaScript.mock.calls.at(-1)?.[0]).toContain('scrollTo(0, 0)')
    expect(wc.invalidate).toHaveBeenCalledTimes(3)
  })
})
