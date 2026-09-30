// Crash reporting for main, renderers and native crashes. Always on in
// packaged builds; in dev only when SENTRY_DSN is set. Home paths are scrubbed
// and navigation breadcrumbs keep only their origin.

import * as Sentry from '@sentry/electron/main'
import { createLogger } from '@kernel/log/contract'
import type { CommonContext } from './analytics/analytics'

declare const __SENTRY_DSN__: string

const log = createLogger('sentry')
let initialized = false

function scrubUrl(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.protocol}//${parsed.host}`
  } catch {
    return '[scrubbed]'
  }
}

function scrubHome(text: string, home: string): string {
  return home ? text.split(home).join('~') : text
}

export function initSentry(options: { isPackaged: boolean; version: string; home: string; context: () => CommonContext }): void {
  const dsn = process.env.SENTRY_DSN || (typeof __SENTRY_DSN__ === 'string' ? __SENTRY_DSN__ : '')
  if (initialized || !dsn || (!options.isPackaged && !process.env.SENTRY_DSN)) return
  const ctx = options.context()
  Sentry.init({
    dsn,
    release: `cate@${options.version}`,
    environment: options.isPackaged ? 'production' : 'development',
    sendDefaultPii: false,
    tracesSampleRate: 0,
    initialScope: {
      user: { id: ctx.install_id },
      tags: {
        app_version: ctx.app_version, platform: ctx.platform, arch: ctx.arch, os_release: ctx.os_release,
        electron_version: ctx.electron_version, node_version: ctx.node_version, chrome_version: ctx.chrome_version, locale: ctx.locale,
      },
    },
    beforeSend(event) {
      try { return JSON.parse(scrubHome(JSON.stringify(event), options.home)) } catch { return event }
    },
    beforeBreadcrumb(crumb) {
      if (crumb.category === 'navigation' || crumb.category === 'fetch' || crumb.category === 'xhr') {
        const data = crumb.data as Record<string, unknown> | undefined
        for (const key of ['url', 'to', 'from']) {
          if (data && typeof data[key] === 'string') data[key] = scrubUrl(data[key] as string)
        }
      }
      return crumb
    },
  })
  initialized = true
  log.info('initialized (release cate@%s)', options.version)
}

export function captureException(error: unknown): void {
  if (!initialized) return
  try { Sentry.captureException(error) } catch { /* never block the crash path */ }
}

export function captureMessage(message: string, extra?: Record<string, unknown>): void {
  if (!initialized) return
  try { Sentry.captureMessage(message, { level: 'error', extra }) } catch { /* best effort */ }
}

export async function flushSentry(): Promise<void> {
  if (!initialized) return
  try { await Sentry.flush(2000) } catch { /* best effort */ }
}
