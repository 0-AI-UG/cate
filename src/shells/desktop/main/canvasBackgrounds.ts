// The canvas wallpaper as managed device data: a picked image is copied into
// `<userData>/canvas-backgrounds/`, named by a hash of its contents, and the
// managed path is stored in the client settings. It survives the source moving.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { createLogger } from '@kernel/log/contract'
import { writeFileAtomic } from '@kernel/state/node'
import { CANVAS_WALLPAPER_MAX_BYTES, canvasWallpaperExtension, canvasWallpaperMime } from '../contract'

const log = createLogger('canvas-backgrounds')

export interface CanvasBackgrounds {
  readonly dir: string
  /** The managed copy's path; the original path when it cannot be copied. */
  importImage(source: string): Promise<string>
  /** Deletes every managed copy but `keepPath` (empty: all). Never throws. */
  prune(keepPath: string): void
  /** A wallpaper as a data URL, or null (wrong type, too large, unreadable). */
  read(filePath: string): Promise<string | null>
}

export function createCanvasBackgrounds(dir: string): CanvasBackgrounds {
  return {
    dir,
    async importImage(source) {
      try {
        if (!canvasWallpaperMime(source)) return source
        const stat = await fs.promises.stat(source)
        if (!stat.isFile() || stat.size > CANVAS_WALLPAPER_MAX_BYTES) return source
        const bytes = await fs.promises.readFile(source)
        const hash = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16)
        const dest = path.join(dir, `${hash}${canvasWallpaperExtension(source)}`)
        if (fs.existsSync(dest)) return dest
        await writeFileAtomic(dest, bytes)
        return dest
      } catch (error) {
        log.warn('import of %s failed, keeping the original path: %O', source, error)
        return source
      }
    },
    prune(keepPath) {
      let entries: string[]
      try { entries = fs.readdirSync(dir) } catch { return }
      const keep = keepPath ? path.resolve(keepPath) : ''
      for (const name of entries) {
        const full = path.join(dir, name)
        if (path.resolve(full) === keep) continue
        try { fs.unlinkSync(full) } catch (error) { log.warn('prune of %s failed: %O', full, error) }
      }
    },
    async read(filePath) {
      // Type and size checks keep a hand-edited setting from turning this into
      // an arbitrary file reader.
      if (typeof filePath !== 'string' || !filePath) return null
      const mime = canvasWallpaperMime(filePath)
      if (!mime) return null
      try {
        const stat = await fs.promises.stat(filePath)
        if (!stat.isFile() || stat.size > CANVAS_WALLPAPER_MAX_BYTES) return null
        return `data:${mime};base64,${(await fs.promises.readFile(filePath)).toString('base64')}`
      } catch (error) {
        log.warn('read of %s failed: %O', filePath, error)
        return null
      }
    },
  }
}
