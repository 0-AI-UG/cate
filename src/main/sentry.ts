// =============================================================================
// Sentry — automatic error/crash reporting for main + renderer + native.
//
// Initialized very early in main. The renderer attaches via @sentry/electron's
// IPC bridge (see src/renderer/lib/sentry.ts). DSN resolution order:
//   1. process.env.SENTRY_DSN  — runtime override (e.g. `dev:sentry`)
//   2. __SENTRY_DSN__          — value baked at build time from SENTRY_DSN
// Packaged builds rely on (2) since end users won't have the env var set.
// When the DSN is empty or the user has opted out, init is a no-op.
// =============================================================================

import { app } from 'electron'
import * as Sentry from '@sentry/electron/main'
import log from './logger'
import { getSettingSync } from './store'
import { getCommonContext } from './appContext'

declare const __SENTRY_DSN__: string

const SENTRY_DSN =
  process.env.SENTRY_DSN ||
  (typeof __SENTRY_DSN__ === 'string' ? __SENTRY_DSN__ : '')

let initialized = false

/** Build the Sentry initialScope from the shared appContext. Pulled out so
 *  the two channels (Sentry + analytics) read from the same source. */
function buildSentryScope() {
  const ctx = getCommonContext()
  return {
    user: { id: ctx.install_id },
    tags: {
      app_version: ctx.app_version,
      platform: ctx.platform,
      arch: ctx.arch,
      os_release: ctx.os_release,
      electron_version: ctx.electron_version,
      node_version: ctx.node_version,
      chrome_version: ctx.chrome_version,
      locale: ctx.locale,
    },
  }
}

function actuallyInit(): void {
  if (initialized) return
  if (!SENTRY_DSN) {
    log.info('[sentry] DSN not configured; skipping init')
    return
  }

  Sentry.init({
    dsn: SENTRY_DSN,
    release: `cate@${app.getVersion()}`,
    environment: app.isPackaged ? 'production' : 'development',
    // Don't include device name / IP / OS user.
    sendDefaultPii: false,
    // Tracing/replay off for now — pure error reporting.
    tracesSampleRate: 0,
    initialScope: buildSentryScope(),
    beforeSend(event) {
      return scrubEvent(event) as typeof event
    },
    beforeBreadcrumb(crumb) {
      // BrowserPanel URLs can contain auth tokens / personal pages.
      // Strip query + path; keep origin only.
      if (crumb.category === 'navigation' || crumb.category === 'fetch' || crumb.category === 'xhr') {
        const data = crumb.data as Record<string, unknown> | undefined
        if (data && typeof data['url'] === 'string') data['url'] = scrubUrl(data['url'] as string)
        if (data && typeof data['to'] === 'string') data['to'] = scrubUrl(data['to'] as string)
        if (data && typeof data['from'] === 'string') data['from'] = scrubUrl(data['from'] as string)
      }
      return crumb
    },
  })

  initialized = true
  log.info('[sentry] initialized (env=%s, release=cate@%s)', app.isPackaged ? 'production' : 'development', app.getVersion())
}

export function initSentry(): void {
  // Hold off entirely until the user has made a first-run telemetry choice —
  // nothing is captured or sent before consent.
  if (!getSettingSync('telemetryConsentDecided')) {
    log.info('[sentry] deferred — awaiting first-run consent')
    return
  }
  if (!getSettingSync('crashReportingEnabled')) {
    log.info('[sentry] disabled by user setting')
    return
  }
  actuallyInit()
}

/**
 * Apply a live change to the crash-reporting toggle. Called by store.ts when
 * the user flips the setting in Settings → General — flushes & closes the
 * Sentry client on opt-out, re-initializes on opt-in. No app restart needed.
 */
export function setCrashReportingEnabled(enabled: boolean): void {
  if (enabled) {
    actuallyInit()
    return
  }
  if (!initialized) return
  try {
    // close() returns a promise that resolves once buffered events flush.
    // We don't await — best-effort, the user opted out.
    void Sentry.close(2000)
  } catch (err) {
    log.warn('[sentry] close failed: %s', err instanceof Error ? err.message : String(err))
  }
  initialized = false
  log.info('[sentry] disabled at runtime')
}

/** Capture an uncaughtException in the main process. Best-effort: returns
 *  immediately if Sentry isn't initialized, so the crash path never blocks. */
export function captureMainException(err: unknown): void {
  if (!initialized) return
  try {
    Sentry.captureException(err)
  } catch (sentryErr) {
    log.warn('[sentry] captureException failed: %s', sentryErr instanceof Error ? sentryErr.message : String(sentryErr))
  }
}

/** Capture a named message event (e.g. a renderer crash that has no JS stack)
 *  with optional structured context. Best-effort, never throws. */
export function captureMainMessage(
  message: string,
  extra?: Record<string, unknown>,
): void {
  if (!initialized) return
  try {
    Sentry.captureMessage(message, { level: 'error', extra })
  } catch (sentryErr) {
    log.warn('[sentry] captureMessage failed: %s', sentryErr instanceof Error ? sentryErr.message : String(sentryErr))
  }
}

/** Flush buffered Sentry events before exiting. Returns a promise that
 *  resolves once flushed or after a 2-second timeout. */
export async function flushSentry(): Promise<void> {
  if (!initialized) return
  try {
    await Sentry.flush(2000)
  } catch {
    /* best-effort */
  }
}

/** Strip the user's home directory from any string field that might carry it. */
function scrubPath(s: string): string {
  const home = app.getPath('home')
  if (!home) return s
  return s.split(home).join('~')
}

function scrubUrl(u: string): string {
  try {
    const parsed = new URL(u)
    return `${parsed.protocol}//${parsed.host}`
  } catch {
    return '[scrubbed]'
  }
}

function scrubEvent(event: unknown): unknown {
  try {
    const json = JSON.stringify(event)
    const scrubbed = scrubPath(json)
    return JSON.parse(scrubbed)
  } catch {
    return event
  }
}
