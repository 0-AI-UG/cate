// Loads node-pty before anything loads @parcel/watcher. Both addons export the
// same node-addon-api callback wrapper and macOS binds every caller to the
// copy loaded first; the watcher's copy has no C++ exception handling, so with
// it a failed PTY spawn (`posix_spawnp failed.`) aborts the whole daemon
// instead of throwing a JS error. main.ts imports this file first.
// Best effort: a host without node-pty still serves files and git.

try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('node-pty')
} catch { /* terminals report it when spawned */ }
