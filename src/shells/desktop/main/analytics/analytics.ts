// Anonymous product telemetry, posted to cero-analytics' /api/app-events.
// Only packaged builds send; dev and e2e builds never do. No file paths,
// project names, workspace contents, hostnames or account data are sent.
// State and the offline buffer live in userData (`analytics-state.json`,
// `pending-events.jsonl`); failed sends are buffered and flushed after the
// next successful one.

import path from 'node:path'
import { createLogger } from '@kernel/log/contract'
import { appendLine, readJsonFile, readTextFile, removeFile, writeJsonFile, writeTextFile } from '@kernel/state/node'
import { PRIVATE_DEVICE_FILES } from '../../contract'
import { decideCensusAction, decideUpdateAction, sanitizeFeedbackPayload, sanitizeUsageProps, type AnalyticsState } from './decisions'

const log = createLogger('analytics')

export const ANALYTICS_ENDPOINT = 'https://analytics.cero-ai.com/api/app-events'
const APP_ID = 'cate'
const MAX_PENDING_BYTES = 256 * 1024

/** Who is running, sent with every event and every crash report. */
export interface CommonContext {
  install_id: string
  app_version: string
  platform: string
  arch: string
  electron_version: string
  node_version: string
  chrome_version: string
  locale: string
  is_packaged: boolean
  os_release: string
}

export interface AnalyticsDeps {
  dir: string
  /** Packaged builds only. */
  enabled: boolean
  context(): CommonContext
  /** POSTs a JSON body; true on 2xx. */
  post(body: string): Promise<boolean>
  installIdPreexisted(): boolean
  /** Asks the main window to show the post-update feedback dialog. */
  promptFeedback(prompt: { fromVersion: string; toVersion: string }): void
}

export interface Analytics {
  send(name: string, props?: Record<string, unknown>): Promise<boolean>
  trackUsage(feature: unknown, props: unknown): void
  /** First install, update detection and `app_start`, once per launch. */
  reportLaunch(currentVersion: string): void
  hasRunBefore(): boolean
  feedbackPending(): { fromVersion: string; toVersion: string } | null
  submitFeedback(raw: unknown): Promise<{ ok: boolean; buffered?: boolean }>
  dismissFeedback(): void
  flushPending(): Promise<void>
  /** Dev only: make the next launch look like an update from one level below. */
  simulateUpdateFrom(current: string, level: 'major' | 'minor' | 'patch'): string
}

export function createAnalytics(deps: AnalyticsDeps): Analytics {
  const stateFile = path.join(deps.dir, PRIVATE_DEVICE_FILES.analyticsState)
  const pendingFile = path.join(deps.dir, PRIVATE_DEVICE_FILES.pendingEvents)
  const readState = () => readJsonFile<AnalyticsState>(stateFile, {})
  const writeState = (state: AnalyticsState) => writeJsonFile(stateFile, state)
  const updateState = (patch: Partial<AnalyticsState>) => writeState({ ...readState(), ...patch })

  const payload = (name: string, props?: Record<string, unknown>) => {
    const ctx = deps.context()
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

  const buffer = (event: object) => {
    const existing = readTextFile(pendingFile) ?? ''
    const line = JSON.stringify(event)
    if (existing.length + line.length + 1 > MAX_PENDING_BYTES) {
      // A long offline streak keeps the newer half.
      const lines = existing.split('\n').filter(Boolean)
      const kept = lines.slice(Math.floor(lines.length / 2))
      writeTextFile(pendingFile, kept.join('\n') + (kept.length ? '\n' : ''))
    }
    appendLine(pendingFile, line)
  }

  const flushPending = async () => {
    const raw = readTextFile(pendingFile)
    if (!raw) return
    const events: unknown[] = []
    for (const line of raw.split('\n').filter(Boolean)) {
      try { events.push(JSON.parse(line)) } catch { /* skip malformed */ }
    }
    if (events.length === 0) {
      removeFile(pendingFile)
      return
    }
    if (await deps.post(JSON.stringify({ app: APP_ID, events }))) removeFile(pendingFile)
  }

  const send = async (name: string, props?: Record<string, unknown>): Promise<boolean> => {
    if (!deps.enabled) return false
    const event = payload(name, props)
    if (await deps.post(JSON.stringify(event))) {
      flushPending().catch(() => {})
      return true
    }
    log.warn('%s failed; buffered', name)
    buffer(event)
    return false
  }

  const clearFeedback = () => updateState({ pendingFeedbackForVersion: undefined, pendingFeedbackFromVersion: undefined })

  return {
    send,
    trackUsage(feature, props) {
      if (typeof feature !== 'string' || !feature) return
      void send('feature_used', { feature: feature.slice(0, 64), ...sanitizeUsageProps(props) })
    },
    reportLaunch(current) {
      const census = decideCensusAction(readState(), deps.installIdPreexisted())
      if (census.kind === 'backfill') {
        void send('app_install_backfill', { from_version: census.fromVersion, prior_run: true })
        updateState({ censusSent: true })
      }
      const action = decideUpdateAction(current, readState())
      if (action.kind === 'first_install') {
        void send('app_install')
        writeState(action.nextState)
      } else if (action.kind === 'version_changed') {
        void send('app_updated', { from_version: action.from, to_version: action.to })
        writeState(action.nextState)
      }
      if (action.kind !== 'first_install' && action.prompt) {
        deps.promptFeedback({ fromVersion: action.prompt.from, toVersion: action.prompt.to })
      }
      void send('app_start')
      flushPending().catch(() => {})
    },
    hasRunBefore: () => !!readState().lastSeenVersion,
    feedbackPending() {
      const state = readState()
      return state.pendingFeedbackForVersion
        ? { fromVersion: state.pendingFeedbackFromVersion ?? '', toVersion: state.pendingFeedbackForVersion }
        : null
    },
    async submitFeedback(raw) {
      const { rating, comment } = sanitizeFeedbackPayload(raw)
      const ok = await send('feedback_submitted', { rating, comment, from_version: readState().pendingFeedbackFromVersion ?? null })
      // Buffered sends flush later; never ask again for the same answer.
      clearFeedback()
      return ok ? { ok: true } : { ok: true, buffered: true }
    },
    dismissFeedback() {
      const state = readState()
      void send('feedback_dismissed', { to_version: state.pendingFeedbackForVersion ?? null, from_version: state.pendingFeedbackFromVersion ?? null })
      clearFeedback()
    },
    flushPending,
    simulateUpdateFrom(current, level) {
      const [major = 0, minor = 0, patch = 0] = current.replace(/^v/, '').split('.').map(Number)
      const from = level === 'major' ? `${major === 0 ? 1 : major - 1}.${minor}.${patch}`
        : level === 'minor' ? `${major}.${minor === 0 ? 1 : minor - 1}.${patch}`
          : `${major}.${minor}.${patch === 0 ? 1 : patch - 1}`
      writeState({ lastSeenVersion: from })
      return from
    },
  }
}
