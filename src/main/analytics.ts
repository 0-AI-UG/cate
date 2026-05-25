// =============================================================================
// Analytics — anonymous product telemetry posted to cero-analytics'
// /api/app-events endpoint. Strictly opt-in via `usageAnalyticsEnabled`.
//
// What we send:
//   - app_start                : version, platform, arch, locale, electron version
//   - app_install              : first launch of this install
//   - app_updated              : from_version → to_version (detected via lastSeenVersion)
//   - update_download_clicked  : user clicked "Download" on the update button
//   - update_install_clicked   : user clicked "Restart" to install
//   - update_manual_open_clicked : user clicked through to GitHub release page
//   - feedback_submitted       : 1-5 rating + optional free-text comment, post-update
//   - feedback_dismissed       : user skipped/closed the post-update feedback dialog
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
import { getSettingSync } from './store'
import { getCommonContext } from './appContext'
import { readJsonFile, writeJsonFile, readTextFile, writeTextFile, appendLine, removeFile } from './jsonFileStore'
import { ANALYTICS_FEEDBACK_PROMPT, ANALYTICS_FEEDBACK_SUBMIT, ANALYTICS_FEEDBACK_DISMISS, ANALYTICS_FEEDBACK_GET_PENDING, ANALYTICS_LINK_CLICK, OPEN_EXTERNAL_URL } from '../shared/ipc-channels'

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
}

function readState(): AnalyticsState {
  return readJsonFile<AnalyticsState>(STATE_FILENAME, {})
}

function writeState(state: AnalyticsState): void {
  writeJsonFile(STATE_FILENAME, state)
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
    log.info('[analytics] %s skipped (usageAnalyticsEnabled=false)', name)
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
  return getSettingSync('usageAnalyticsEnabled') !== false
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
  | { kind: 'first_install'; emit: 'app_install'; nextState: AnalyticsState; prompt: { from: string; to: string } }
  | { kind: 'no_change'; nextState: AnalyticsState; prompt?: { from: string; to: string } }
  | {
      kind: 'version_changed'
      emit: 'app_updated'
      from: string
      to: string
      nextState: AnalyticsState
      prompt?: { from: string; to: string }
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
      nextState: {
        ...state,
        lastSeenVersion: current,
        pendingFeedbackForVersion: current,
        pendingFeedbackFromVersion: '',
      },
      prompt: { from: '', to: current },
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
  if (process.env.DEV_FORCE_DIALOG) {
    promptFeedback(mainWin, app.getVersion(), '0.0.0')
    return
  }

  const current = app.getVersion()
  const state = readState()
  const action = decideUpdateAction(current, state)

  switch (action.kind) {
    case 'first_install':
      void sendEvent('app_install')
      writeState(action.nextState)
      promptFeedback(mainWin, action.prompt.to, action.prompt.from)
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
