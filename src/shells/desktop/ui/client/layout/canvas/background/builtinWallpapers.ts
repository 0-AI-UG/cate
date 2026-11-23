// Wallpapers that ship with the app. A built-in pick is stored in the same
// `canvasBackgroundImagePath` setting as a custom one, tagged `builtin:<id>`.
// The images are bundled assets, so they render without the shell port.

import hillside from './assets/hillside.webp'
import lighthouse from './assets/lighthouse.webp'
import snowyPass from './assets/snowy-pass.webp'

export const BUILTIN_WALLPAPER_PREFIX = 'builtin:'

export interface BuiltinWallpaper {
  /** Stable id in the stored setting value (`builtin:<id>`). */
  id: string
  name: string
  /** Bundled asset URL, for the thumbnail and the backdrop. */
  url: string
}

export const BUILTIN_WALLPAPERS: BuiltinWallpaper[] = [
  { id: 'hillside', name: 'Hillside', url: hillside },
  { id: 'lighthouse', name: 'Lighthouse', url: lighthouse },
  { id: 'snowy-pass', name: 'Snowy Pass', url: snowyPass },
]

function isBuiltinWallpaperPath(path: string | undefined | null): boolean {
  return !!path && path.startsWith(BUILTIN_WALLPAPER_PREFIX)
}

export function getBuiltinWallpaper(path: string | undefined | null): BuiltinWallpaper | undefined {
  if (!path || !isBuiltinWallpaperPath(path)) return undefined
  const id = path.slice(BUILTIN_WALLPAPER_PREFIX.length)
  return BUILTIN_WALLPAPERS.find((w) => w.id === id)
}
