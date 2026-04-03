// =============================================================================
// Logger — centralized logging for the main process, backed by electron-log.
// Writes to ~/Library/Logs/Cate/main.log (macOS) with 5MB rotation.
// Renderer processes use electron-log/renderer which sends logs here via IPC.
// =============================================================================

import log from 'electron-log/main'

// Enable renderer→main IPC so renderer logs land in the same file
log.initialize()

// File transport: persist info+ to disk
log.transports.file.level = 'info'
log.transports.file.maxSize = 5 * 1024 * 1024 // 5MB per file
log.transports.file.format = '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] {text}'

// Console transport: verbose in dev, quiet in prod
log.transports.console.level = process.env.NODE_ENV === 'development' ? 'debug' : 'warn'

// Catch uncaughtException + unhandledRejection globally
log.errorHandler.startCatching()

export default log
