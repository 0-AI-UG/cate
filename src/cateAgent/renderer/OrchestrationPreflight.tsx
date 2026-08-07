import { CheckCircle, WarningCircle } from '@phosphor-icons/react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { AgentId } from '../../shared/agents'
import {
  evaluateAgentCliHooks,
  inspectAgentCliHooks,
  type AgentCliHookState,
} from '../../renderer/lib/agent/agentCliHooks'
import { getAgentLogoById } from '../../renderer/lib/agent/agentLogos'
import { useSettingsStore } from '../../renderer/stores/settingsStore'

const EMPTY_HOOK_OVERRIDES = {}

export function useOrchestrationPreflight({
  active,
  workspaceId,
  rootPath,
}: {
  active: boolean
  workspaceId: string
  rootPath: string
}) {
  const [agents, setAgents] = useState<AgentCliHookState[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const overrides = useSettingsStore((state) =>
    state.agentHookInjection[workspaceId] ?? EMPTY_HOOK_OVERRIDES,
  )

  const refresh = useCallback(async () => {
    if (!active || !rootPath) return
    setAgents(null)
    setError(null)
    try {
      setAgents(await inspectAgentCliHooks(rootPath))
    } catch (cause) {
      setAgents([])
      setError(cause instanceof Error ? cause.message : 'Cate could not inspect agent hooks.')
    }
  }, [active, rootPath])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const evaluated = useMemo(() => (agents ?? []).map((agent) => ({
    agent,
    ready: evaluateAgentCliHooks(agent, overrides).ready,
  })), [agents, overrides])
  const readyCount = evaluated.filter((entry) => entry.ready).length

  const enable = useCallback((agentId: AgentId): void => {
    const store = useSettingsStore.getState()
    store.setSetting('agentHookInjection', {
      ...store.agentHookInjection,
      [workspaceId]: {
        ...(store.agentHookInjection[workspaceId] ?? {}),
        [agentId]: 'on',
      },
    })
  }, [workspaceId])

  const status = !active
    ? null
    : error
      ? 'hooks unavailable'
      : agents === null
        ? 'checking hooks…'
        : `${readyCount}/${evaluated.length} hooks`

  return { agents, error, evaluated, readyCount, refresh, enable, status }
}

/** Compact hook-readiness content rendered in the Parallel agents popover.
 * Selecting On is sufficient for a new worker: files are injected on spawn. */
export function OrchestrationPreflight({
  state,
}: {
  state: ReturnType<typeof useOrchestrationPreflight>
}) {
  const { agents, error, evaluated, readyCount, refresh, enable } = state

  return (
    <div data-orchestration-preflight className="text-[11px]">
      <div className="mb-1.5 flex items-center gap-2 text-[10px]">
        <span className="flex-1 text-muted">Hooks</span>
        <span className="shrink-0 text-secondary">
          {agents === null ? 'Checking…' : `${readyCount}/${evaluated.length} ready`}
        </span>
        {error && (
          <button className="text-agent hover:text-agent-light" onClick={() => { void refresh() }}>
            Retry
          </button>
        )}
      </div>
      {error ? (
        <div className="flex items-start gap-1.5 text-warning">
          <WarningCircle size={13} className="mt-px shrink-0" />
          <span>{error}</span>
        </div>
      ) : agents === null ? (
        <div className="h-16 animate-pulse rounded bg-surface-2" />
      ) : (
        <div
          data-agent-preflight-list
          className="overflow-hidden rounded-md border border-subtle bg-surface-2 divide-y divide-subtle"
        >
          {evaluated.map(({ agent, ready }) => {
            const logo = getAgentLogoById(agent.agent.id)
            return (
              <div
                key={agent.agent.id}
                data-agent-preflight-id={agent.agent.id}
                className="flex h-6 min-w-0 items-center gap-1.5 px-1.5"
              >
                {logo && (
                  <img
                    src={logo}
                    alt=""
                    width={12}
                    height={12}
                    className="block h-3 w-3 shrink-0 object-contain"
                    draggable={false}
                  />
                )}
                <span className="min-w-0 flex-1 truncate text-[10px] text-primary">
                  {agent.agent.displayName}
                </span>
                {ready ? (
                  <CheckCircle size={10} weight="fill" className="shrink-0 text-[#34C759]" />
                ) : (
                  <>
                    <WarningCircle size={10} weight="fill" className="shrink-0 text-warning" />
                    <button
                      className="shrink-0 text-[10px] text-agent hover:text-agent-light"
                      onClick={() => enable(agent.agent.id)}
                    >
                      Enable
                    </button>
                  </>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
