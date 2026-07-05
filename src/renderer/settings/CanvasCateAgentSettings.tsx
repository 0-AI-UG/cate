// =============================================================================
// CanvasCateAgentSettings — the Cate Agent's own settings section.
//
// The Cate Agent is always on; what's configurable is how it behaves:
//   - Automatic observations are per-workspace (.cate/cateAgent.json), so that
//     toggle acts on the selected workspace.
//   - Everything else (observation frequency, model, coding agent, parallel
//     attempts) is a global pref (settings.json) shared across workspaces.
//
// The model picker reuses ModelPrefRow from the agent ProvidersView so it looks
// identical to the global Default-model control; every other control is the
// shared settings kit (SettingRow / Toggle / Select / NumberInput).
// =============================================================================

import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { ModelPrefRow, type PickModels } from '../../agent/renderer/ProvidersView'
import { loadCateAgentModel, saveCateAgentModel } from '../../agent/renderer/agentModelPrefs'
import { AGENTS } from '../../shared/agents'
import type { AgentModelRef } from '../../shared/types'
import { useAppStore } from '../stores/appStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useCateAgentWs } from '../cateAgent/cateAgentStore'
import { cateAgentController } from '../cateAgent/cateAgentController'
import { SettingRow, Toggle, Select, NumberInput, SearchableBlock } from './SettingsComponents'
import log from '../lib/logger'

export function CanvasCateAgentSettings() {
  return (
    <div className="flex flex-col gap-1">
      <CateAgentObservations />
      <CateAgentModels />
      <CateAgentJobs />
    </div>
  )
}

// Dim + freeze a control when its setting doesn't currently apply (the base
// controls have no disabled state of their own).
function Gated({ disabled, children }: { disabled: boolean; children: ReactNode }) {
  return <div className={disabled ? 'opacity-40 pointer-events-none' : ''}>{children}</div>
}

// --- observations (workspace toggle + global frequency) ----------------------

const OBSERVE_FREQUENCY_OPTIONS = [
  { value: '1', label: 'Every minute' },
  { value: '5', label: 'Every 5 minutes' },
  { value: '15', label: 'Every 15 minutes' },
  { value: '60', label: 'Every hour' },
]

function CateAgentObservations() {
  const wsId = useAppStore((s) => s.selectedWorkspaceId)
  const rootPath = useAppStore((s) => s.workspaces.find((w) => w.id === s.selectedWorkspaceId)?.rootPath ?? '')
  const cateAgent = useCateAgentWs(wsId)
  const cooldownMin = useSettingsStore((s) => s.cateAgentObserveCooldownMin)
  const setSetting = useSettingsStore((s) => s.setSetting)
  const ready = !!wsId && !!rootPath

  return (
    <>
      {!ready && (
        <SearchableBlock keywords="cate agent observe observations">
          <p className="text-xs text-muted py-2.5 border-b border-subtle">
            Open a folder to configure observations for that workspace.
          </p>
        </SearchableBlock>
      )}
      <SettingRow
        label="Automatic observations"
        description="Let the Cate Agent observe the workspace on its own and suggest tasks. Off: it only looks when you ask it."
      >
        <Gated disabled={!ready}>
          <Toggle
            checked={cateAgent.autoObserve}
            onChange={(v) => cateAgentController.setAutoObserve(wsId!, rootPath, v)}
          />
        </Gated>
      </SettingRow>
      <SettingRow
        label="Observation frequency"
        description="How often it may take an automatic look. Applies to every workspace with automatic observations on."
      >
        <Gated disabled={ready && !cateAgent.autoObserve}>
          <Select
            value={String(cooldownMin)}
            onChange={(v) => setSetting('cateAgentObserveCooldownMin', Number(v) || 1)}
            options={OBSERVE_FREQUENCY_OPTIONS}
          />
        </Gated>
      </SettingRow>
    </>
  )
}

// --- model (global) -----------------------------------------------------------

function CateAgentModels() {
  // Selectable models, derived from the connected providers in auth.json (same
  // source the global Default-model picker uses).
  const [models, setModels] = useState<PickModels>([])
  const [model, setModel] = useState<AgentModelRef | null>(() => loadCateAgentModel())
  const [open, setOpen] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const mList = await window.electronAPI.agentListModels()
      setModels(mList.map((m) => ({ provider: m.provider, model: m.id, label: m.label })))
    } catch (err) {
      log.warn('[CanvasCateAgentSettings] model list refresh failed', err)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  // Connecting/disconnecting a provider in another view changes which models are
  // pickable — re-pull when the main process broadcasts an auth change.
  useEffect(() => {
    if (!window.electronAPI?.onAuthChanged) return
    return window.electronAPI.onAuthChanged(() => { void refresh() })
  }, [refresh])

  const handlePick = (m: { provider: string; model: string } | null) => {
    const next = m ? { provider: m.provider, model: m.model } : null
    saveCateAgentModel(next)
    setModel(next)
    setOpen(false)
  }

  return (
    <SearchableBlock keywords="cate agent model">
      <ModelPrefRow
        label="Cate Agent model"
        sublabel="The model the Cate Agent uses to observe, suggest, and run tasks."
        models={models}
        current={model}
        open={open}
        setOpen={setOpen}
        onPick={handlePick}
        noneLabel="Default model"
      />
    </SearchableBlock>
  )
}

// --- jobs (global) ------------------------------------------------------------

function CateAgentJobs() {
  const agentId = useSettingsStore((s) => s.cateAgentOrchestratorAgentId)
  const maxParallel = useSettingsStore((s) => s.cateAgentMaxParallelIterations)
  const setSetting = useSettingsStore((s) => s.setSetting)

  return (
    <>
      <SettingRow
        label="Coding agent"
        description="The CLI each attempt launches to write the code. The Cate Agent can still override it per attempt."
      >
        <Select
          value={agentId}
          onChange={(v) => setSetting('cateAgentOrchestratorAgentId', v)}
          options={[
            { value: '', label: 'Let the Cate Agent choose' },
            ...AGENTS.map((a) => ({ value: a.id, label: a.displayName })),
          ]}
        />
      </SettingRow>
      <SettingRow
        label="Parallel attempts"
        description="Most attempts a job may run at once. Each gets its own worktree and coding agents."
      >
        <NumberInput
          value={maxParallel}
          onChange={(v) => setSetting('cateAgentMaxParallelIterations', v)}
          min={1}
          max={8}
        />
      </SettingRow>
    </>
  )
}
