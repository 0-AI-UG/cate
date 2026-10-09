import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  bitmap: Buffer.alloc(0),
  output: Buffer.from('opaque-png'),
  createFromBitmap: vi.fn(),
}))

vi.mock('electron', () => ({
  nativeImage: {
    createFromBuffer: vi.fn(() => ({
      getSize: () => ({ width: 3, height: 1 }),
      toBitmap: () => Buffer.from(h.bitmap),
    })),
    createFromBitmap: h.createFromBitmap,
  },
}))

import { flattenScreenshotPng } from './screenshotPng'

describe('flattenScreenshotPng', () => {
  beforeEach(() => {
    h.createFromBitmap.mockReset()
    h.createFromBitmap.mockReturnValue({ toPNG: () => h.output })
  })

  it('composites transparent pixels onto white and makes every pixel opaque', () => {
    h.bitmap = Buffer.from([
      0, 0, 0, 0,
      0, 0, 0, 255,
      0, 0, 0, 128,
    ])

    expect(flattenScreenshotPng(Buffer.from('source-png'))).toBe(h.output)
    expect(h.createFromBitmap).toHaveBeenCalledWith(Buffer.from([
      255, 255, 255, 255,
      0, 0, 0, 255,
      127, 127, 127, 255,
    ]), {
      width: 3,
      height: 1,
    })
  })
})
