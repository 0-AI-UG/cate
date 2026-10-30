// Anonymous product telemetry, posted to cero-analytics' shared event endpoint.
// Only packaged builds send; dev and e2e builds never do. No file paths,
// project names, workspace contents, hostnames or account data are sent.
// State and the offline buffer live in userData (`analytics-state.json`,
// `pending-events.jsonl`); failed sends are buffered and flushed after the
// next successful one.

import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createLogger } from '@kernel/log/contract'
import { appendLine, readJsonFile, readTextFile, removeFile, writeJsonFile, writeTextFile } from '@kernel/state/node'
import { PRIVATE_DEVICE_FILES } from '../../contract'
import { decideCensusAction, decideUpdateAction, sanitizeUsageProps, type AnalyticsState } from './decisions'

const log = createLogger('analytics')

export const ANALYTICS_ENDPOINT = 'https://analytics.cero-ai.com/api/service-events?app=cate'
const APP_ID = 'cate'
const MAX_PENDING_BYTES = 256 * 1024
const DELIVERY_TIMEOUT_MS = 15_000

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
}

export interface Analytics {
  send(name: string, props?: Record<string, unknown>): Promise<boolean>
  trackUsage(feature: unknown, props: unknown): void
  /** First install, update detection and `app_start`, once per launch. */
  reportLaunch(currentVersion: string): void
  hasRunBefore(): boolean
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
      event_id: randomUUID(),
      event_name: name,
      timestamp: new Date().toISOString(),
      data: {
        ...props,
        install_id: ctx.install_id,
        app_version: ctx.app_version,
        platform: ctx.platform,
        arch: ctx.arch,
        electron_version: ctx.electron_version,
        locale: ctx.locale,
        is_packaged: ctx.is_packaged,
      },
    }
  }

  // Serialize delivery and replay so concurrent events cannot erase buffered
  // events or replay the same offline queue at the same time.
  let delivery: Promise<unknown> = Promise.resolve()
  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = delivery.then(operation)
    delivery = result.catch(() => {})
    return result
  }
  const post = async (event: unknown) => {
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        deps.post(JSON.stringify(event)),
        new Promise<boolean>(resolve => { timeout = setTimeout(() => resolve(false), DELIVERY_TIMEOUT_MS) }),
      ])
    } catch { return false } finally { clearTimeout(timeout) }
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

  const replay = async () => {
    const raw = readTextFile(pendingFile)
    if (!raw) return
    const lines = raw.split('\n').filter(Boolean)
    for (let index = 0; index < lines.length; index++) {
      let event: ReturnType<typeof payload>
      try { event = JSON.parse(lines[index]) } catch { continue }
      // Invalid records (including the retired wire format) are never sent.
      if (!event || event.app !== APP_ID || typeof event.event_id !== 'string'
        || typeof event.timestamp !== 'string' || typeof event.event_name !== 'string'
        || !event.data || typeof event.data !== 'object' || Array.isArray(event.data)) continue
      if (!await post(event)) {
        writeTextFile(pendingFile, lines.slice(index).join('\n') + '\n')
        return
      }
    }
    removeFile(pendingFile)
  }
  const flushPending = () => deps.enabled ? enqueue(replay) : Promise.resolve()

  const send = (name: string, props?: Record<string, unknown>): Promise<boolean> => {
    if (!deps.enabled) return Promise.resolve(false)
    const event = payload(name, props)
    return enqueue(async () => {
      if (await post(event)) {
        await replay()
        return true
      }
      log.warn('%s failed; buffered', name)
      buffer(event)
      return false
    })
  }

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
      void send('app_start')
      flushPending().catch(() => {})
    },
    hasRunBefore: () => !!readState().lastSeenVersion,
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
