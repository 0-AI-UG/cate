import fs from 'node:fs'
import path from 'node:path'
import { formatLogLine, levelAtLeast, type LogLevel, type LogSink } from '../contract'

export interface FileSinkOptions {
  /** Absolute path of the log file. */
  file: string
  /** Records below this level are dropped. Default `info`. */
  level?: LogLevel
  /** Rotate to `<name>.old<ext>` past this size. Default 5 MB. */
  maxBytes?: number
}

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024

function rotatedPath(file: string): string {
  const ext = path.extname(file)
  return `${file.slice(0, file.length - ext.length)}.old${ext}`
}

/** Appends one formatted line per record. Writes are synchronous so a crash
 *  right after a log call still leaves the line on disk. */
export function createFileSink(options: FileSinkOptions): LogSink {
  const { file, level = 'info', maxBytes = DEFAULT_MAX_BYTES } = options
  let size = -1
  let ready = false

  const prepare = (): void => {
    if (ready) return
    fs.mkdirSync(path.dirname(file), { recursive: true })
    try { size = fs.statSync(file).size } catch { size = 0 }
    ready = true
  }

  return (record) => {
    if (!levelAtLeast(record.level, level)) return
    try {
      prepare()
      const line = formatLogLine(record) + '\n'
      if (size + line.length > maxBytes && size > 0) {
        fs.renameSync(file, rotatedPath(file))
        size = 0
      }
      fs.appendFileSync(file, line, 'utf-8')
      size += Buffer.byteLength(line)
    } catch {
      ready = false
    }
  }
}
