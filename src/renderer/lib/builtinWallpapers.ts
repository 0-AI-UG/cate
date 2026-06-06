// =============================================================================
// builtinWallpapers — wallpapers that ship inside the app, so the user can pick
// one straight from Settings without browsing the filesystem.
//
// A built-in selection is stored in the same `canvasBackgroundImagePath` setting
// as a custom pick, but tagged with the `builtin:` prefix (e.g. `builtin:hillside`)
// so it's distinguishable from an absolute filesystem path. The images are Vite
// asset imports, so they resolve to bundled URLs and render directly in the
// renderer — no main-process round-trip (CANVAS_READ_BACKGROUND_IMAGE) needed.
// =============================================================================

import hillside from '../assets/wallpapers/hillside.webp'

export const BUILTIN_WALLPAPER_PREFIX = 'builtin:'

export interface BuiltinWallpaper {
  /** Stable id used in the stored setting value (`builtin:<id>`). */
  id: string
  /** Human label shown in Settings. */
  name: string
  /** Bundled asset URL for both the preview thumbnail and the full backdrop. */
  url: string
}

export const BUILTIN_WALLPAPERS: BuiltinWallpaper[] = [
  { id: 'hillside', name: 'Hillside', url: hillside },
]

/** The stored setting value for a given built-in wallpaper. */
export function builtinWallpaperPath(id: string): string {
  return `${BUILTIN_WALLPAPER_PREFIX}${id}`
}

/** True when a stored path refers to a built-in wallpaper rather than a file. */
export function isBuiltinWallpaperPath(path: string | undefined | null): boolean {
  return !!path && path.startsWith(BUILTIN_WALLPAPER_PREFIX)
}

/** Resolve a stored path to its built-in wallpaper, or undefined if it isn't one. */
export function getBuiltinWallpaper(path: string | undefined | null): BuiltinWallpaper | undefined {
  if (!isBuiltinWallpaperPath(path)) return undefined
  const id = path!.slice(BUILTIN_WALLPAPER_PREFIX.length)
  return BUILTIN_WALLPAPERS.find((w) => w.id === id)
}
