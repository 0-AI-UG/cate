// =============================================================================
// Sentry renderer init — attaches to the main-process Sentry instance via the
// @sentry/electron IPC bridge. No-op when DSN is unset.
// =============================================================================

import * as Sentry from '@sentry/electron/renderer'

let initialized = false

export function initRendererSentry(): void {
  if (initialized) return
  // The renderer SDK reads configured options (DSN, release, environment,
  // beforeSend path scrubbing, etc.) from the main process via IPC and no-ops
  // if main didn't initialize Sentry. We just wire up the global handlers.
  Sentry.init({})
  initialized = true
}
