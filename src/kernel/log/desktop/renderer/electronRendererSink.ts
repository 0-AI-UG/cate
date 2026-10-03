import log from 'electron-log/renderer'
import type { LogSink } from '../../contract'

/** Desktop renderer: records travel to main's log file over electron-log IPC. */
export function createElectronRendererSink(): LogSink {
  return (record) => {
    const text = record.scope ? `[${record.scope}] ${record.message}` : record.message
    log[record.level](text, ...record.args)
  }
}
