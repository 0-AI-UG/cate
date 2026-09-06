import type { AgentHookEvent } from '../../../shared/agentHooks'
import type { AgentTitleResolvers } from './types'

const DEFAULT_RETRY_DELAYS_MS = [0, 250, 1_000, 3_000] as const
const MAX_TITLE_LENGTH = 120

export interface AgentTitleTracker {
  note(event: AgentHookEvent): void
  dispose(): void
}

export interface AgentTitleTrackerOptions {
  homeDir: string
  resolvers: AgentTitleResolvers
  emit: (event: AgentHookEvent) => void
  retryDelaysMs?: readonly number[]
}

/** Make persisted CLI metadata safe and useful as a one-line panel label. */
export function normalizeAgentTitle(value: string | null): string | null {
  const title = value?.replace(/\s+/g, ' ').trim()
  if (!title) return null
  return title.length <= MAX_TITLE_LENGTH
    ? title
    : `${title.slice(0, MAX_TITLE_LENGTH - 1).trimEnd()}…`
}

/**
 * Resolve native chat titles off the latency-sensitive hook ingestion path.
 * A short bounded retry window covers CLIs that write their session index just
 * after the hook fires. Each newer hook/session supersedes older work, and an
 * unchanged title is never re-emitted.
 */
export function createAgentTitleTracker(options: AgentTitleTrackerOptions): AgentTitleTracker {
  const delays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS
  const generations = new Map<string, number>()
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const lastEmitted = new Map<string, string>()
  let disposed = false

  const clearTimer = (terminalId: string): void => {
    const timer = timers.get(terminalId)
    if (timer) clearTimeout(timer)
    timers.delete(terminalId)
  }

  const schedule = (event: AgentHookEvent): void => {
    const { terminalId, agentId, sessionId } = event
    if (!sessionId) return

    clearTimer(terminalId)
    const generation = (generations.get(terminalId) ?? 0) + 1
    generations.set(terminalId, generation)

    const attempt = async (attemptIndex: number): Promise<void> => {
      if (disposed || generations.get(terminalId) !== generation) return
      let title: string | null = null
      try {
        title = normalizeAgentTitle(await options.resolvers[agentId]({
          event,
          homeDir: options.homeDir,
        }))
      } catch {
        // Session metadata is best-effort. A missing/corrupt/changing CLI store
        // must never interfere with the agent's hook or terminal lifecycle.
      }
      if (disposed || generations.get(terminalId) !== generation) return
      if (title) {
        const key = `${agentId}\0${sessionId}\0${title}`
        if (lastEmitted.get(terminalId) !== key) {
          lastEmitted.set(terminalId, key)
          options.emit({
            terminalId,
            agentId,
            kind: 'session-title',
            sessionId,
            cwd: event.cwd,
            transcriptPath: event.transcriptPath,
            title,
            raw: {},
          })
        }
        clearTimer(terminalId)
        return
      }
      const next = attemptIndex + 1
      if (next >= delays.length) {
        timers.delete(terminalId)
        return
      }
      const timer = setTimeout(() => {
        timers.delete(terminalId)
        void attempt(next)
      }, Math.max(0, delays[next] - delays[attemptIndex]))
      timer.unref?.()
      timers.set(terminalId, timer)
    }

    const firstDelay = delays[0] ?? 0
    const timer = setTimeout(() => {
      timers.delete(terminalId)
      void attempt(0)
    }, firstDelay)
    timer.unref?.()
    timers.set(terminalId, timer)
  }

  return {
    note(event) {
      if (disposed || event.kind === 'session-title' || event.kind === 'input-submit' || event.kind === 'input-interrupt') return
      if (event.kind === 'session-end') {
        clearTimer(event.terminalId)
        generations.set(event.terminalId, (generations.get(event.terminalId) ?? 0) + 1)
        lastEmitted.delete(event.terminalId)
        return
      }
      schedule(event)
    },
    dispose() {
      disposed = true
      for (const terminalId of timers.keys()) clearTimer(terminalId)
      generations.clear()
      lastEmitted.clear()
    },
  }
}
