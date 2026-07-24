import { describe, expect, test } from 'vitest'
import {
  CANVAS_WALLPAPER_MAX_BYTES,
  CANVAS_WALLPAPER_PICKER_EXTENSIONS,
  canvasWallpaperExtension,
  canvasWallpaperMime,
  isCanvasWallpaperPath,
} from './canvasWallpaper'

describe('canvasWallpaper policy', () => {
  test('uses one bounded positive size limit', () => {
    expect(CANVAS_WALLPAPER_MAX_BYTES).toBe(40 * 1024 * 1024)
  })

  test('normalizes supported extensions and maps them to MIME types', () => {
    expect(canvasWallpaperExtension('C:\\Pictures\\Backdrop.JPEG')).toBe('.jpeg')
    expect(canvasWallpaperMime('/tmp/background.JPEG')).toBe('image/jpeg')
    expect(canvasWallpaperMime('/tmp/background.webp')).toBe('image/webp')
  })

  test('rejects missing and unsupported extensions', () => {
    expect(isCanvasWallpaperPath('/tmp/background')).toBe(false)
    expect(isCanvasWallpaperPath('/tmp/background.svg')).toBe(false)
  })

  test('keeps picker formats aligned with accepted MIME formats', () => {
    expect(CANVAS_WALLPAPER_PICKER_EXTENSIONS).toEqual([
      'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif',
    ])
  })
})
