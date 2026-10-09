import log from 'electron-log/main'
import type { LogSink } from '../../contract'

let initialized = false

/** Desktop main: electron-log writes `main.log` (5 MB rotation) and receives
 *  the renderer's records over its IPC transport. Install once at startup. */
export function createElectronMainSink(options: { dev: boolean }): LogSink {
  if (!initialized) {
    initialized = true
    log.initialize()
    log.transports.file.level = 'info'
    log.transports.file.maxSize = 5 * 1024 * 1024
    log.transports.file.format = '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] {text}'
    // Packaged macOS apps launched from Finder have no stdout/stderr; writes throw EIO.
    log.transports.console.level = options.dev ? 'debug' : false
    process.stderr?.on?.('error', () => {})
    process.stdout?.on?.('error', () => {})
    log.errorHandler.startCatching()
  }
  return (record) => {
    const text = record.scope ? `[${record.scope}] ${record.message}` : record.message
    log[record.level](text, ...record.args)
  }
}
