// Canvas wallpaper formats. The picker, the managed copy under
// `canvas-backgrounds/` and the data URL the renderer paints all use this map.

/** Largest accepted wallpaper. Import and read both enforce it. */
export const CANVAS_WALLPAPER_MAX_BYTES = 40 * 1024 * 1024

export const CANVAS_WALLPAPER_MIME_BY_EXTENSION = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
} as const

type WallpaperExtension = keyof typeof CANVAS_WALLPAPER_MIME_BY_EXTENSION

/** Without the leading dot, as native pickers expect. */
export const CANVAS_WALLPAPER_PICKER_EXTENSIONS: readonly string[] = Object.keys(CANVAS_WALLPAPER_MIME_BY_EXTENSION).map((ext) => ext.slice(1))

/** Lowercase extension with its dot, or ''. */
export function canvasWallpaperExtension(filePath: string): string {
  const base = filePath.slice(Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\')) + 1)
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot).toLowerCase() : ''
}

export function canvasWallpaperMime(filePath: string): string | null {
  return CANVAS_WALLPAPER_MIME_BY_EXTENSION[canvasWallpaperExtension(filePath) as WallpaperExtension] ?? null
}
