// =============================================================================
// Test stub for `electron-log` (aliased in vitest.config.ts for both the
// `electron-log/renderer` and `electron-log/main` entry points).
//
// The real `electron-log/renderer` BLOCKS at module evaluation under vitest (it
// tries to wire up Electron IPC that never resolves), so ANY test importing a
// module whose graph reaches the logger would hang the worker — and, in CI, hang
// the whole run. Routing electron-log to this inert stub makes the logger a
// no-op in tests so no import can hang. Production builds use electron-vite's
// own config and are unaffected by this alias.
// =============================================================================

const noop = (..._args: unknown[]): void => {}

const logger: Record<string, unknown> = {
  info: noop,
  warn: noop,
  error: noop,
  debug: noop,
  verbose: noop,
  silly: noop,
  log: noop,
  initialize: noop,
  catchErrors: noop,
  scope: () => logger,
  create: () => logger,
  transports: {
    file: { level: 'info', maxSize: 0, format: '' },
    console: { level: false },
    ipc: { level: false },
  },
  errorHandler: { startCatching: noop, stopCatching: noop },
}

export default logger
export const info = noop
export const warn = noop
export const error = noop
export const debug = noop
export const verbose = noop
export const silly = noop
