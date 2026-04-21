// =============================================================================
// Crash Reporter — saves crash data to disk on fatal errors, prompts user to
// send a report on next launch. Reports are only sent with explicit consent.
// =============================================================================

import fs from 'fs'
import path from 'path'
import os from 'os'
import { app, dialog, BrowserWindow, net } from 'electron'
import log from './logger'

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Where crash reports are posted when the user opts in. */
const CRASH_REPORT_ENDPOINT = 'https://crashes.cate.dev/api/v1/reports'

const CRASH_REPORT_FILENAME = 'crash-report.json'
const CRASH_REPORT_ARCHIVE_DIR = 'crash-reports'
const MAX_ARCHIVED_REPORTS = 50
const MAX_RECENT_LOG_LINES = 80

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CrashReport {
  timestamp: string
  error: {
    name: string
    message: string
    stack?: string
  }
  source: 'main' | 'renderer'
  app: {
    version: string
    electron: string
    chrome: string
    node: string
  }
  system: {
    platform: string
    arch: string
    osVersion: string
    totalMemory: number
    freeMemory: number
  }
  recentLogs: string[]
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function crashReportPath(): string {
  return path.join(app.getPath('userData'), CRASH_REPORT_FILENAME)
}

function crashReportArchiveDir(): string {
  return path.join(app.getPath('userData'), CRASH_REPORT_ARCHIVE_DIR)
}

/**
 * Drop archived reports past the retention cap. Safe to call any time.
 * Extracted so `checkPendingCrashReport` can apply the cap after its
 * rename-based claim instead of duplicating the logic.
 */
function pruneArchivedReports(): void {
  try {
    const dir = crashReportArchiveDir()
    if (!fs.existsSync(dir)) return
    const entries = fs
      .readdirSync(dir)
      .filter((name) => name.startsWith('crash-') && name.endsWith('.json'))
      .sort()
    if (entries.length > MAX_ARCHIVED_REPORTS) {
      for (const stale of entries.slice(0, entries.length - MAX_ARCHIVED_REPORTS)) {
        tryUnlink(path.join(dir, stale))
      }
    }
  } catch (err) {
    log.warn('Failed to prune crash archive: %s', err instanceof Error ? err.message : String(err))
  }
}

/** Read the last N lines from the main log file (best-effort). */
function readRecentLogLines(): string[] {
  try {
    const logPath = log.transports.file.getFile()?.path
    if (!logPath) return []
    const content = fs.readFileSync(logPath, 'utf-8')
    const lines = content.split('\n').filter(Boolean)
    return lines.slice(-MAX_RECENT_LOG_LINES)
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// Save — called from uncaughtException / renderer IPC
// ---------------------------------------------------------------------------

/**
 * Persist a crash report to disk. Must be synchronous (called during crash).
 * Only one report is kept — a subsequent crash overwrites the previous one.
 */
export function saveCrashReport(
  error: Error | { name?: string; message: string; stack?: string },
  source: 'main' | 'renderer' = 'main',
): void {
  const report: CrashReport = {
    timestamp: new Date().toISOString(),
    error: {
      name: error.name ?? 'Error',
      message: error.message,
      stack: error.stack,
    },
    source,
    app: {
      version: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
    },
    system: {
      platform: process.platform,
      arch: process.arch,
      osVersion: os.release(),
      totalMemory: os.totalmem(),
      freeMemory: os.freemem(),
    },
    recentLogs: readRecentLogLines(),
  }

  try {
    fs.writeFileSync(crashReportPath(), JSON.stringify(report, null, 2), 'utf-8')
    log.info('Crash report saved to %s', crashReportPath())
  } catch (err) {
    // Last resort — if we can't write the crash report, there's nothing we can do
    log.error('Failed to save crash report:', err)
  }
}

// ---------------------------------------------------------------------------
// Check on startup — show opt-in dialog if a pending report exists
// ---------------------------------------------------------------------------

/**
 * Check for a pending crash report from a previous session. If one exists,
 * show a native dialog asking the user whether to send it.
 *
 * The pending report is atomically renamed into the archive directory as
 * the *first* step — before any parsing or dialog. That way the pending
 * file is guaranteed gone from the pickup path before the UI promises
 * anything, even if parsing throws or the user kills the app mid-dialog.
 * This replaces the old "dialog then tryUnlink" flow, which would
 * silently leave the file behind on any filesystem hiccup and re-show
 * the dialog on every subsequent startup.
 *
 * Call this after the main window has been created so the dialog can be
 * parented to it.
 */
export async function checkPendingCrashReport(): Promise<void> {
  const reportPath = crashReportPath()
  if (!fs.existsSync(reportPath)) return

  const dir = crashReportArchiveDir()
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch (err) {
    log.warn('Failed to ensure crash archive dir: %s', err instanceof Error ? err.message : String(err))
    // Fall through — rename will fail below, we'll fall back to delete.
  }

  // Atomic claim: rename the pending report into the archive with a
  // timestamped name. Same filesystem → this is guaranteed atomic on
  // POSIX and on NTFS.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const archivedPath = path.join(dir, `crash-${stamp}.json`)
  let claimedPath: string
  try {
    fs.renameSync(reportPath, archivedPath)
    claimedPath = archivedPath
  } catch (err) {
    // Cross-device rename (rare, but e.g. if userData lives on a
    // different volume than the archive dir) — copy + delete instead.
    try {
      fs.copyFileSync(reportPath, archivedPath)
      fs.unlinkSync(reportPath)
      claimedPath = archivedPath
    } catch (fallbackErr) {
      log.warn(
        'Failed to claim pending crash report (rename: %s; copy fallback: %s). Discarding to avoid re-showing the dialog.',
        err instanceof Error ? err.message : String(err),
        fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr),
      )
      // Last resort — if we can't move it, at least delete it so it
      // doesn't keep re-triggering the dialog. If *that* fails too,
      // tryUnlink logs the failure so we can diagnose.
      tryUnlink(reportPath)
      return
    }
  }

  let raw: string
  try {
    raw = fs.readFileSync(claimedPath, 'utf-8')
  } catch (err) {
    log.warn('Failed to read claimed crash report: %s', err instanceof Error ? err.message : String(err))
    return
  }

  let report: CrashReport
  try {
    report = JSON.parse(raw) as CrashReport
  } catch {
    log.warn('Claimed crash report was not valid JSON — discarding')
    tryUnlink(claimedPath)
    return
  }

  // Apply the archive retention cap now that we've added one.
  pruneArchivedReports()

  log.info('Found pending crash report from %s (%s: %s)', report.timestamp, report.error.name, report.error.message)

  const parentWindow = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()) ?? undefined

  const { response, checkboxChecked } = await dialog.showMessageBox(parentWindow!, {
    type: 'warning',
    title: 'Cate crashed unexpectedly',
    message: 'Cate quit unexpectedly during your last session.',
    detail: [
      `Error: ${report.error.message}`,
      '',
      'Would you like to send a crash report to help us fix this?',
      'The report includes the error details, app version, and recent log entries. No personal data or file contents are included.',
    ].join('\n'),
    buttons: ['Send Report', 'Don\u2019t Send'],
    defaultId: 0,
    cancelId: 1,
    checkboxLabel: 'Include recent log lines',
    checkboxChecked: true,
  })

  if (response === 0) {
    if (!checkboxChecked) {
      report.recentLogs = []
    }
    await sendCrashReport(report)
  } else {
    log.info('User declined to send crash report')
  }
}

// ---------------------------------------------------------------------------
// Send — POST to crash report endpoint
// ---------------------------------------------------------------------------

async function sendCrashReport(report: CrashReport): Promise<void> {
  log.info('Sending crash report to %s', CRASH_REPORT_ENDPOINT)

  try {
    const body = JSON.stringify(report)
    const request = net.request({
      method: 'POST',
      url: CRASH_REPORT_ENDPOINT,
    })
    request.setHeader('Content-Type', 'application/json')
    request.setHeader('User-Agent', `Cate/${app.getVersion()}`)

    await new Promise<void>((resolve, reject) => {
      request.on('response', (response) => {
        if (response.statusCode && response.statusCode >= 200 && response.statusCode < 300) {
          log.info('Crash report sent successfully (status %d)', response.statusCode)
        } else {
          log.warn('Crash report server returned status %d', response.statusCode)
        }
        // Drain the response body to avoid leaking the connection
        response.on('data', () => {})
        response.on('end', () => resolve())
        response.on('error', () => resolve()) // Don't fail on response read errors
      })
      request.on('error', (err) => {
        log.warn('Failed to send crash report:', err)
        reject(err)
      })
      request.write(body)
      request.end()
    })
  } catch (err) {
    // Sending is best-effort — don't disrupt the user's session
    log.warn('Crash report send failed:', err)
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function tryUnlink(filePath: string): void {
  try {
    fs.unlinkSync(filePath)
  } catch (err) {
    // Silent failure here is what caused the "dialog on every restart"
    // regression — log it so a future silent failure is diagnosable.
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return
    log.warn('Failed to unlink %s: %s', filePath, err instanceof Error ? err.message : String(err))
  }
}
