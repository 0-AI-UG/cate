// Structured logging for every process. Code logs through `createLogger(scope)`;
// the host process installs the sink (a file in the daemon, electron-log in
// desktop main, the console or an injected sink in a client). Nothing here
// touches a file, so the daemon bundle never pulls in electron-log.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error']

export interface LogRecord {
  level: LogLevel
  scope: string
  /** printf-style template (`%s`, `%d`, `%i`, `%f`, `%j`, `%o`, `%O`, `%%`). */
  message: string
  args: unknown[]
  time: number
}

export type LogSink = (record: LogRecord) => void

export interface Logger {
  readonly scope: string
  debug(message: string, ...args: unknown[]): void
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
  /** A logger for a sub-scope, `parent:child`. */
  child(scope: string): Logger
}

export function levelAtLeast(level: LogLevel, threshold: LogLevel): boolean {
  return LOG_LEVELS.indexOf(level) >= LOG_LEVELS.indexOf(threshold)
}

function inspect(value: unknown): string {
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/** Substitute printf placeholders; leftover args are appended space-separated. */
export function formatLogMessage(message: string, args: readonly unknown[]): string {
  let next = 0
  const text = message.replace(/%([sdifjoO%])/g, (match, spec: string) => {
    if (spec === '%') return '%'
    if (next >= args.length) return match
    const arg = args[next++]
    switch (spec) {
      case 's': return typeof arg === 'string' ? arg : inspect(arg)
      case 'd':
      case 'i': return String(spec === 'i' ? Math.trunc(Number(arg)) : Number(arg))
      case 'f': return String(Number(arg))
      default: return inspect(arg)
    }
  })
  const rest = args.slice(next).map(inspect)
  return rest.length > 0 ? `${text} ${rest.join(' ')}` : text
}

/** One line: `[2026-01-02 03:04:05.678] [warn] [scope] text`. */
export function formatLogLine(record: LogRecord): string {
  const d = new Date(record.time)
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0')
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
    + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
  const scope = record.scope ? ` [${record.scope}]` : ''
  return `[${stamp}] [${record.level}]${scope} ${formatLogMessage(record.message, record.args)}`
}

/** Writes to the global console. The default sink until a host installs one. */
export function createConsoleSink(threshold: LogLevel = 'info'): LogSink {
  return (record) => {
    if (!levelAtLeast(record.level, threshold)) return
    const scope = record.scope ? `[${record.scope}] ` : ''
    const text = scope + formatLogMessage(record.message, record.args)
    if (record.level === 'error') console.error(text)
    else if (record.level === 'warn') console.warn(text)
    else if (record.level === 'info') console.info(text)
    else console.debug(text)
  }
}

const defaultSink = createConsoleSink()
let activeSink: LogSink = defaultSink

/** Install the process-wide sink; `null` restores the console default. */
export function installLogSink(sink: LogSink | null): void {
  activeSink = sink ?? defaultSink
}

/** Fan one record out to several sinks, isolating their failures. */
export function combineSinks(...sinks: LogSink[]): LogSink {
  return (record) => {
    for (const sink of sinks) {
      try { sink(record) } catch { /* a broken sink must not break logging */ }
    }
  }
}

export function createLogger(scope: string): Logger {
  const emit = (level: LogLevel, message: string, args: unknown[]): void => {
    try {
      activeSink({ level, scope, message, args, time: Date.now() })
    } catch {
      // Logging never throws into the caller (a closed stderr raises EIO).
    }
  }
  return {
    scope,
    debug: (message, ...args) => emit('debug', message, args),
    info: (message, ...args) => emit('info', message, args),
    warn: (message, ...args) => emit('warn', message, args),
    error: (message, ...args) => emit('error', message, args),
    child: (sub) => createLogger(scope ? `${scope}:${sub}` : sub),
  }
}
