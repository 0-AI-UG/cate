/** Maximum accepted wallpaper size. Both import and read paths enforce this. */
export const CANVAS_WALLPAPER_MAX_BYTES = 40 * 1024 * 1024

/** Canonical wallpaper formats. The same map drives the native picker, managed
 *  copy validation, and data-URL MIME generation. */
export const CANVAS_WALLPAPER_MIME_BY_EXTENSION = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
} as const

export type CanvasWallpaperExtension = keyof typeof CANVAS_WALLPAPER_MIME_BY_EXTENSION
export type CanvasWallpaperMime =
  (typeof CANVAS_WALLPAPER_MIME_BY_EXTENSION)[CanvasWallpaperExtension]

/** Extensions in the no-leading-dot form Electron's file picker expects. */
export const CANVAS_WALLPAPER_PICKER_EXTENSIONS = Object.freeze(
  Object.keys(CANVAS_WALLPAPER_MIME_BY_EXTENSION).map((extension) => extension.slice(1)),
)

/** Lowercase filename extension including its leading dot, or empty string. */
export function canvasWallpaperExtension(filePath: string): string {
  const basename = filePath.slice(Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\')) + 1)
  const dot = basename.lastIndexOf('.')
  return dot > 0 ? basename.slice(dot).toLowerCase() : ''
}

export function canvasWallpaperMime(filePath: string): CanvasWallpaperMime | null {
  const extension = canvasWallpaperExtension(filePath) as CanvasWallpaperExtension
  return CANVAS_WALLPAPER_MIME_BY_EXTENSION[extension] ?? null
}

export function isCanvasWallpaperPath(filePath: string): boolean {
  return canvasWallpaperMime(filePath) != null
}
