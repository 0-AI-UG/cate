import { nativeImage } from 'electron'

/**
 * Browser pages commonly leave the root background transparent. Composite the
 * capture onto white and remove alpha so black page text stays visible in
 * viewers with a dark transparency background.
 */
export function flattenScreenshotPng(png: Buffer): Buffer {
  const image = nativeImage.createFromBuffer(png)
  const size = image.getSize()
  const bitmap = image.toBitmap()

  // Electron exposes Chromium's premultiplied BGRA bitmap. Compositing a
  // premultiplied channel over white is channel + (255 - alpha).
  for (let offset = 0; offset < bitmap.length; offset += 4) {
    const alpha = bitmap[offset + 3]
    const white = 255 - alpha
    bitmap[offset] = Math.min(255, bitmap[offset] + white)
    bitmap[offset + 1] = Math.min(255, bitmap[offset + 1] + white)
    bitmap[offset + 2] = Math.min(255, bitmap[offset + 2] + white)
    bitmap[offset + 3] = 255
  }

  return nativeImage.createFromBitmap(bitmap, size).toPNG()
}
