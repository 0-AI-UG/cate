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

declare const __SENTRY_DSN__: string

const SENTRY_DSN =
  process.env.SENTRY_DSN ||
  (typeof __SENTRY_DSN__ === 'string' ? __SENTRY_DSN__ : '')

let initialized = false

export function initSentry(): void {
  if (initialized) return
  if (!SENTRY_DSN) {
    log.info('[sentry] DSN not configured; skipping init')
    return
  }
  if (!getSettingSync('crashReportingEnabled')) {
    log.info('[sentry] disabled by user setting')
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
