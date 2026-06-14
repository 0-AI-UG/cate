// =============================================================================
// Analytics — anonymous product telemetry posted to cero-analytics'
// /api/app-events endpoint. Events send only from packaged builds — telemetry
// is always on there; dev/E2E builds never send (see isEnabled()).
//
// What we send:
//   - app_start                : version, platform, arch, locale, electron version
//   - app_install              : first launch of this install
//   - app_install_backfill     : one-time census of a pre-existing install that
//                                ran an earlier (opt-in) build but never sent
//                                telemetry. Carries from_version (last seen) so
//                                the backend can count it as a recovered install
//                                without inflating "new installs". See
//                                decideCensusAction.
//   - app_updated              : from_version → to_version (detected via lastSeenVersion)
//   - update_download_clicked  : user clicked "Download" on the update button
//   - update_install_clicked   : user clicked "Restart" to install
//   - update_manual_open_clicked : user clicked through to GitHub release page
//   - feedback_submitted       : 1-5 rating + optional free-text comment, post-update
//   - feedback_dismissed       : user skipped/closed the post-update feedback dialog
//   - agent_message_sent       : user sent a message to an agent — kind (prompt/
//                                steer/follow_up), char count, has_images. No text.
//
// What we deliberately do NOT send: file paths, project names, workspace
// contents, hostname, IP-derived identifiers, user account info.
//
// State + offline buffer live under <userData>/ (analytics-state.json,
// pending-events.jsonl).  Failed sends are appended to the buffer and flushed
// on next init / next successful send so feedback isn't lost when offline.
// =============================================================================

import { app, BrowserWindow, ipcMain, net, shell } from 'electron'
import log from './logger'
import { getCommonContext } from './appContext'
import { installIdPreexisted } from './installId'
import { readJsonFile, writeJsonFile, readTextFile, writeTextFile, appendLine, removeFile } from './jsonFileStore'
import { ANALYTICS_FEEDBACK_PROMPT, ANALYTICS_FEEDBACK_SUBMIT, ANALYTICS_FEEDBACK_DISMISS, ANALYTICS_FEEDBACK_GET_PENDING, ANALYTICS_LINK_CLICK, ANALYTICS_TRACK_USAGE, OPEN_EXTERNAL_URL } from '../shared/ipc-channels'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const ENDPOINT = 'https://analytics.cero-ai.com/api/app-events'
const APP_ID = 'cate'
const STATE_FILENAME = 'analytics-state.json'
const PENDING_FILENAME = 'pending-events.jsonl'
const MAX_PENDING_BYTES = 256 * 1024 // cap the offline buffer so it can't grow unbounded

// ---------------------------------------------------------------------------
// State persistence
// ---------------------------------------------------------------------------

export interface AnalyticsState {
  lastSeenVersion?: string
  /** When set, the renderer should show the post-update feedback modal once.
   *  Cleared after the user submits or dismisses. */
  pendingFeedbackForVersion?: string
  /** Track previous version so the feedback event can include both. */
  pendingFeedbackFromVersion?: string
  /** Set once the one-time install census (app_install_backfill) has been
   *  emitted for a previously-silent install, so it never re-fires. */
  censusSent?: boolean
}

function readState(): AnalyticsState {
  return readJsonFile<AnalyticsState>(STATE_FILENAME, {})
}

/** Whether Cate has been launched before on this machine (sync). Used to scope
 *  the onboarding tour to genuine first installs — anyone who has run a prior
 *  version (so has a recorded lastSeenVersion) is treated as already onboarded. */
export function hasRunBefore(): boolean {
  return !!readState().lastSeenVersion
}

function writeState(state: AnalyticsState): void {
  writeJsonFile(STATE_FILENAME, state)
}

/** Dev-only: seed the analytics state so the next launch looks like an update
 *  from a synthetic previous version one `level` below the current app version.
 *  Returns the synthesized "from" version. A major/minor delta triggers the
 *  post-update feedback dialog; a patch delta intentionally does not. */
export function devSimulateUpdateFrom(level: 'major' | 'minor' | 'patch'): string {
  const [maj = 0, min = 0, pat = 0] = app.getVersion().replace(/^v/, '').split('.').map(Number)
  const from =
    level === 'major' ? `${maj === 0 ? maj + 1 : maj - 1}.${min}.${pat}`
    : level === 'minor' ? `${maj}.${min === 0 ? min + 1 : min - 1}.${pat}`
    : `${maj}.${min}.${pat === 0 ? pat + 1 : pat - 1}`
  writeState({ lastSeenVersion: from })
  return from
}

function updateState(patch: Partial<AnalyticsState>): void {
  writeState({ ...readState(), ...patch })
}

// ---------------------------------------------------------------------------
// Event shape — first-class context columns plus a free-form `props` bag.
// ---------------------------------------------------------------------------

interface AppEventPayload {
  app: string
  event_name: string
  install_id: string
  app_version: string
  platform: string
  arch: string
  electron_version: string
  locale: string
  is_packaged: boolean
  props?: Record<string, unknown>
}

function buildPayload(name: string, props?: Record<string, unknown>): AppEventPayload {
  const ctx = getCommonContext()
  return {
    app: APP_ID,
    event_name: name,
    install_id: ctx.install_id,
    app_version: ctx.app_version,
    platform: ctx.platform,
    arch: ctx.arch,
    electron_version: ctx.electron_version,
    locale: ctx.locale,
    is_packaged: ctx.is_packaged,
    ...(props ? { props } : {}),
  }
}

// ---------------------------------------------------------------------------
// HTTP — POST a single event or a batch. Returns true on 2xx, false otherwise.
// ---------------------------------------------------------------------------

function postEvents(body: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const request = net.request({ method: 'POST', url: ENDPOINT })
      request.setHeader('Content-Type', 'application/json')
      request.setHeader('User-Agent', `Cate/${app.getVersion()}`)
      let settled = false
      const done = (ok: boolean) => { if (!settled) { settled = true; resolve(ok) } }
      request.on('response', (res) => {
        res.on('data', () => {})
        res.on('end', () => done(!!(res.statusCode && res.statusCode >= 200 && res.statusCode < 300)))
        res.on('error', () => done(false))
      })
      request.on('error', (err) => {
        log.warn('[analytics] request error: %s', err.message)
        done(false)
      })
      request.write(body)
      request.end()
    } catch (err) {
      log.warn('[analytics] request threw: %s', err instanceof Error ? err.message : String(err))
      resolve(false)
    }
  })
}

// ---------------------------------------------------------------------------
// Offline buffer — append failed events to a jsonl file under userData; flush
// in batch when a later send succeeds (or on init).
// ---------------------------------------------------------------------------

function bufferEvent(payload: AppEventPayload): void {
  // Cap total file size so a long offline streak can't fill the disk.
  const existing = readTextFile(PENDING_FILENAME) ?? ''
  const line = JSON.stringify(payload)
  if (existing.length + line.length + 1 > MAX_PENDING_BYTES) {
    // Drop oldest half — split on \n, keep the newer half, append.
    const lines = existing.split('\n').filter(Boolean)
    const kept = lines.slice(Math.floor(lines.length / 2))
    writeTextFile(PENDING_FILENAME, kept.join('\n') + (kept.length ? '\n' : ''))
  }
  appendLine(PENDING_FILENAME, line)
}

async function flushPending(): Promise<void> {
  const raw = readTextFile(PENDING_FILENAME)
  if (!raw) return
  const lines = raw.split('\n').filter(Boolean)
  if (lines.length === 0) {
    removeFile(PENDING_FILENAME)
    return
  }
  const events: AppEventPayload[] = []
  for (const line of lines) {
    try { events.push(JSON.parse(line) as AppEventPayload) } catch { /* skip malformed */ }
  }
  if (events.length === 0) {
    removeFile(PENDING_FILENAME)
    return
  }
  log.info('[analytics] flushing %d buffered event(s)', events.length)
  const ok = await postEvents(JSON.stringify({ app: APP_ID, events }))
  if (ok) {
    removeFile(PENDING_FILENAME)
    log.info('[analytics] flushed buffered events ✓')
  } else {
    log.info('[analytics] flush failed; keeping buffer for next attempt')
  }
}

// ---------------------------------------------------------------------------
// Send — single-event entrypoint. Returns the eventual success status.
// On failure the event is buffered and the promise resolves false.
// ---------------------------------------------------------------------------

async function sendEvent(name: string, props?: Record<string, unknown>): Promise<boolean> {
  if (!isEnabled()) {
    log.info('[analytics] %s skipped (unpackaged build)', name)
    return false
  }
  const payload = buildPayload(name, props)
  const body = JSON.stringify(payload)
  log.info('[analytics] → POST event=%s bytes=%d', name, body.length)
  const ok = await postEvents(body)
  if (ok) {
    log.info('[analytics] %s ✓', name)
    // Piggyback a flush on a successful send (cheap, common case is empty).
    flushPending().catch(() => {})
    return true
  }
  log.warn('[analytics] %s failed → buffered', name)
  bufferEvent(payload)
  return false
}

// ---------------------------------------------------------------------------
// Settings + context
// ---------------------------------------------------------------------------

function isEnabled(): boolean {
  // Telemetry is always on in packaged builds (no settings gate, no opt-out).
  // Dev and E2E builds (unpackaged) never send. The informational telemetry
  // notice (WelcomeDialog) is not a gate — it only records acknowledgement.
  return app.isPackaged
}

/** Keep only a few small primitive props (string/number/boolean), with strings
 *  clamped short — defends the usage channel against free-form text or paths
 *  riding along in props. Exported for tests. */
export function sanitizeUsageProps(raw: unknown): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {}
  if (!raw || typeof raw !== 'object') return out
  let n = 0
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (n >= 6) break
    if (typeof v === 'string') out[k.slice(0, 32)] = v.slice(0, 48)
    else if (typeof v === 'number' || typeof v === 'boolean') out[k.slice(0, 32)] = v
    else continue
    n++
  }
  return out
}

/** Clamp + truncate raw IPC payload from the renderer. Exported for tests. */
export function sanitizeFeedbackPayload(payload: unknown): { rating: number; comment: string } {
  const p = (payload ?? {}) as { rating?: unknown; comment?: unknown }
  const rating = Math.max(1, Math.min(5, Math.round(Number(p.rating) || 0)))
  const comment = typeof p.comment === 'string' ? p.comment.slice(0, 1000) : ''
  return { rating, comment }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export { sendEvent }

export function initAnalytics(): void {
  // Renderer submits feedback. Returns an ack so the modal can show success /
  // failure rather than blindly claiming success.
  ipcMain.handle(ANALYTICS_FEEDBACK_SUBMIT, async (_e, raw: unknown): Promise<{ ok: boolean; buffered?: boolean }> => {
    const { rating, comment } = sanitizeFeedbackPayload(raw)
    const state = readState()
    const ok = await sendEvent('feedback_submitted', {
      rating,
      comment,
      from_version: state.pendingFeedbackFromVersion ?? null,
    })
    // Clear pending state regardless — if send failed, the event was buffered
    // and will be flushed on next successful send. We don't want to re-prompt
    // the user every launch for the same response.
    updateState({ pendingFeedbackForVersion: undefined, pendingFeedbackFromVersion: undefined })
    return ok ? { ok: true } : { ok: true, buffered: true }
  })

  ipcMain.on(ANALYTICS_FEEDBACK_DISMISS, () => {
    const state = readState()
    void sendEvent('feedback_dismissed', {
      to_version: state.pendingFeedbackForVersion ?? null,
      from_version: state.pendingFeedbackFromVersion ?? null,
    })
    updateState({ pendingFeedbackForVersion: undefined, pendingFeedbackFromVersion: undefined })
  })

  ipcMain.handle(ANALYTICS_FEEDBACK_GET_PENDING, (): { fromVersion: string; toVersion: string } | null => {
    const state = readState()
    if (state.pendingFeedbackForVersion) {
      return {
        fromVersion: state.pendingFeedbackFromVersion ?? '',
        toVersion: state.pendingFeedbackForVersion,
      }
    }
    return null
  })

  ipcMain.on(ANALYTICS_LINK_CLICK, (_e, link: string) => {
    void sendEvent('promo_link_clicked', { link })
  })

  // Anonymous feature-usage signal. The renderer reports a short feature key
  // (+ optional small primitive props); we clamp it hard so no free-form text
  // / file paths / project data can ride along. Gated by isEnabled via sendEvent.
  ipcMain.on(ANALYTICS_TRACK_USAGE, (_e, raw: unknown) => {
    const payload = (raw ?? {}) as { feature?: unknown; props?: unknown }
    if (typeof payload.feature !== 'string' || !payload.feature) return
    const feature = payload.feature.slice(0, 64)
    void sendEvent('feature_used', { feature, ...sanitizeUsageProps(payload.props) })
  })

  ipcMain.on(OPEN_EXTERNAL_URL, (_e, url: string) => {
    if (typeof url === 'string' && (url.startsWith('https://') || url.startsWith('http://'))) {
      shell.openExternal(url)
    }
  })

  // Best-effort flush of anything left from a previous session.
  flushPending().catch(() => {})
}

// ---------------------------------------------------------------------------
// Pure decision logic — given the current app version and the persisted
// analytics state, return what should happen next (events to emit, state to
// persist, whether to show the feedback prompt and with which versions).
// Extracted so it can be unit-tested without mocking electron, fs, or net.
// ---------------------------------------------------------------------------

export type UpdateAction =
  // First install emits app_install but does NOT queue a feedback prompt — the
  // onboarding tour is the first-run welcome, so the promo/feedback dialog would
  // overlap it. The dialog is for updates only.
  | { kind: 'first_install'; emit: 'app_install'; nextState: AnalyticsState }
  | { kind: 'no_change'; nextState: AnalyticsState; prompt?: { from: string; to: string } }
  | {
      kind: 'version_changed'
      emit: 'app_updated'
      from: string
      to: string
      nextState: AnalyticsState
      prompt?: { from: string; to: string }
    }

// ---------------------------------------------------------------------------
// Install census — one-time backfill of installs that existed under an earlier
// opt-in build but never sent telemetry. Such an install has a recorded
// `lastSeenVersion` (checkAndReportUpdate wrote it even when sends were gated
// off) yet no install-id file (the id is written only inside the send path).
// We emit a single `app_install_backfill` so the backend can count it as a
// recovered install. Genuinely-new installs have no lastSeenVersion; installs
// that already sent telemetry had their install-id file pre-exist — neither
// qualifies, so this can't double-count. Pure for unit testing.
// ---------------------------------------------------------------------------

export type CensusAction =
  | { kind: 'none' }
  | { kind: 'backfill'; fromVersion: string; nextState: AnalyticsState }

export function decideCensusAction(state: AnalyticsState, installIdPreexistedFlag: boolean): CensusAction {
  if (state.censusSent) return { kind: 'none' }
  // Already counted: a pre-existing install-id means telemetry was sent before.
  if (installIdPreexistedFlag) return { kind: 'none' }
  // Brand-new install: nothing to backfill (a normal app_install covers it).
  if (!state.lastSeenVersion) return { kind: 'none' }
  return {
    kind: 'backfill',
    fromVersion: state.lastSeenVersion,
    nextState: { ...state, censusSent: true },
  }
}

function isMajorOrMinorBump(from: string, to: string): boolean {
  const pa = from.replace(/^v/, '').split('.').map(Number)
  const pb = to.replace(/^v/, '').split('.').map(Number)
  return (pb[0] || 0) !== (pa[0] || 0) || (pb[1] || 0) !== (pa[1] || 0)
}

export function decideUpdateAction(current: string, state: AnalyticsState): UpdateAction {
  const previous = state.lastSeenVersion

  if (!previous) {
    return {
      kind: 'first_install',
      emit: 'app_install',
      // No pendingFeedback*: the first-run welcome is the onboarding tour, so we
      // never surface the feedback/promo dialog on a brand-new install.
      nextState: { ...state, lastSeenVersion: current },
    }
  }

  if (previous === current) {
    const action: UpdateAction = { kind: 'no_change', nextState: state }
    // Re-prompt if a previous launch queued feedback but the user killed the
    // app before answering. The pending flag is cleared on submit/dismiss.
    // Only re-prompt for major/minor bumps.
    if (state.pendingFeedbackForVersion === current &&
        isMajorOrMinorBump(state.pendingFeedbackFromVersion ?? '0.0.0', current)) {
      action.prompt = { from: state.pendingFeedbackFromVersion ?? previous, to: current }
    }
    return action
  }

  const showPrompt = isMajorOrMinorBump(previous, current)

  return {
    kind: 'version_changed',
    emit: 'app_updated',
    from: previous,
    to: current,
    nextState: {
      ...state,
      lastSeenVersion: current,
      pendingFeedbackForVersion: showPrompt ? current : undefined,
      pendingFeedbackFromVersion: showPrompt ? previous : undefined,
    },
    prompt: showPrompt ? { from: previous, to: current } : undefined,
  }
}

/**
 * Compare current app version against the last-seen version persisted on disk.
 * Thin IO wrapper around `decideUpdateAction` — see that function for the
 * actual behavior matrix.
 */
export async function checkAndReportUpdate(mainWin: BrowserWindow): Promise<void> {
  // E2E profiles start from a fresh version state every run, which looks like a
  // first install / version bump and would pop the post-update feedback modal.
  // That modal intercepts pointer events and flakes tests — never show it here.
  if (process.env.CATE_E2E === '1') return

  if (process.env.DEV_FORCE_DIALOG) {
    promptFeedback(mainWin, app.getVersion(), '0.0.0')
    return
  }

  const current = app.getVersion()

  // One-time install census: backfill a pre-existing install that ran an
  // earlier opt-in build but never sent telemetry. Runs alongside (not instead
  // of) the normal app_start/app_updated flow. Persist censusSent first, then
  // re-read so the update decision below preserves the flag.
  const census = decideCensusAction(readState(), installIdPreexisted())
  if (census.kind === 'backfill') {
    void sendEvent('app_install_backfill', { from_version: census.fromVersion, prior_run: true })
    updateState({ censusSent: true })
  }

  const state = readState()
  const action = decideUpdateAction(current, state)

  switch (action.kind) {
    case 'first_install':
      void sendEvent('app_install')
      writeState(action.nextState)
      // No feedback prompt — the onboarding tour is the first-run welcome.
      return
    case 'version_changed':
      void sendEvent('app_updated', { from_version: action.from, to_version: action.to })
      writeState(action.nextState)
      if (action.prompt) promptFeedback(mainWin, action.prompt.to, action.prompt.from)
      return
    case 'no_change':
      if (action.prompt) promptFeedback(mainWin, action.prompt.to, action.prompt.from)
      return
  }
}

function promptFeedback(mainWin: BrowserWindow, toVersion: string, fromVersion: string): void {
  if (!mainWin || mainWin.isDestroyed()) return
  // Give the renderer a moment to mount before showing the modal — keeps the
  // prompt from competing with the first paint.
  setTimeout(() => {
    if (mainWin.isDestroyed()) return
    mainWin.webContents.send(ANALYTICS_FEEDBACK_PROMPT, { fromVersion, toVersion })
  }, 2500)
}

export function trackAppStart(): void {
  void sendEvent('app_start')
}
