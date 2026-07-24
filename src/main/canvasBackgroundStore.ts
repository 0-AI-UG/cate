// =============================================================================
// canvasBackgroundStore — owns the canvas wallpaper image as managed app data.
//
// When the user picks a background image we COPY it into
// `<userData>/canvas-backgrounds/` and store that managed path in settings,
// rather than referencing the original file. This makes the wallpaper durable:
// it survives the source file being moved/renamed/deleted and is self-contained
// under userData (alongside the rest of Cate's persisted state). The copy is
// named by a hash of its contents so re-picking the same image is idempotent.
//
// `prune` keeps the directory to just the current wallpaper, deleting orphaned
// copies left by a replace/clear/crash. The renderer still reads bytes via
// CANVAS_READ_BACKGROUND_IMAGE (which points at the managed path).
// =============================================================================

import { app } from 'electron'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import log from './logger'
import { writeTextAtomic } from './writeJsonAtomic'
import {
  CANVAS_WALLPAPER_MAX_BYTES,
  canvasWallpaperExtension,
  isCanvasWallpaperPath,
} from '../shared/canvasWallpaper'

const DIR_NAME = 'canvas-backgrounds'

function backgroundsDir(): string {
  return path.join(app.getPath('userData'), DIR_NAME)
}

/**
 * Copy `sourcePath` into the managed backgrounds directory and return the
 * managed absolute path. Validates extension + size (so a bad pick can't bloat
 * userData). On any failure, falls back to returning the original path so the
 * feature degrades to a plain reference rather than breaking.
 */
export async function importCanvasBackgroundImage(sourcePath: string): Promise<string> {
  try {
    const ext = canvasWallpaperExtension(sourcePath)
    if (!isCanvasWallpaperPath(sourcePath)) return sourcePath
    const stat = await fs.promises.stat(sourcePath)
    if (!stat.isFile() || stat.size > CANVAS_WALLPAPER_MAX_BYTES) return sourcePath

    const buf = await fs.promises.readFile(sourcePath)
    const hash = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16)
    const dir = backgroundsDir()
    const dest = path.join(dir, `${hash}${ext}`)

    // Idempotent: identical contents reuse the same managed file.
    try {
      await fs.promises.access(dest)
      return dest
    } catch { /* not present — write it below */ }

    await writeTextAtomic(dest, buf)
    return dest
  } catch (err) {
    log.warn('[canvasBackgroundStore] import of %s failed, keeping original path: %O', sourcePath, err)
    return sourcePath
  }
}

/**
 * Delete every managed background except `keepPath`. Called whenever the
 * setting changes so replacing or clearing the wallpaper reclaims the old copy,
 * and once at startup to clear crash-orphaned files. Best-effort; never throws.
 */
export function pruneCanvasBackgrounds(keepPath: string): void {
  const dir = backgroundsDir()
  let entries: string[]
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return // directory absent — nothing to prune
  }
  const keep = keepPath ? path.resolve(keepPath) : ''
  for (const name of entries) {
    const full = path.join(dir, name)
    if (path.resolve(full) === keep) continue
    try {
      fs.unlinkSync(full)
    } catch (err) {
      log.warn('[canvasBackgroundStore] prune of %s failed: %O', full, err)
    }
  }
}
