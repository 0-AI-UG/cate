// =============================================================================
// CanvasPetSettings — the Canvas Pet's own settings section.
//
// Enablement (on/off + automatic observations) for the current workspace plus
// the models the pet runs on. Enablement is per-workspace (.cate/pet.json), so
// the toggles act on the selected workspace; the models + coding agent are
// global prefs (settings.json), shared across every workspace's pet.
//
// The model picker rows reuse ModelPrefRow from the agent ProvidersView so they
// look identical to the global Default-model control.
// =============================================================================

import { useCallback, useEffect, useState } from 'react'
import { ModelPrefRow, type PickModels } from '../../agent/renderer/ProvidersView'
import {
  loadPetModel,
  savePetModel,
  loadPetExecutorAgentId,
  savePetExecutorAgentId,
} from '../../agent/renderer/agentModelPrefs'
import { AGENTS } from '../../shared/agents'
import type { AgentModelRef } from '../../shared/types'
import { useAppStore } from '../stores/appStore'
import { usePetWs } from '../pet/petStore'
import { petController } from '../pet/petController'
import { SettingRow, Toggle, SearchableBlock } from './SettingsComponents'
import log from '../lib/logger'

export function CanvasPetSettings() {
  return (
    <div className="flex flex-col gap-1">
      <PetEnablement />
      <PetModels />
    </div>
  )
}

// --- enablement (per-workspace) ---------------------------------------------

function PetEnablement() {
  const wsId = useAppStore((s) => s.selectedWorkspaceId)
  const rootPath = useAppStore((s) => s.workspaces.find((w) => w.id === s.selectedWorkspaceId)?.rootPath ?? '')
  const pet = usePetWs(wsId)
  const ready = !!wsId && !!rootPath

  return (
    <>
      {!ready && (
        <SearchableBlock keywords="canvas pet enable">
          <p className="text-xs text-muted py-2.5 border-b border-subtle">
            Open a folder to enable the pet for that workspace.
          </p>
        </SearchableBlock>
      )}
      <SettingRow
        label="Enable pet"
        description="Summon the companion that watches the workspace and runs approved tasks."
      >
        <GatedToggle
          checked={pet.enabled}
          disabled={!ready}
          onChange={(v) => {
            if (v) void petController.summon(wsId!, rootPath)
            else void petController.dismiss(wsId!, rootPath)
          }}
        />
      </SettingRow>
      <SettingRow
        label="Automatic observations"
        description="Let the pet observe on its own and suggest tasks. Off: it only looks when you click it."
      >
        <GatedToggle
          checked={pet.autoObserve}
          disabled={!ready || !pet.enabled}
          onChange={(v) => petController.setAutoObserve(wsId!, rootPath, v)}
        />
      </SettingRow>
    </>
  )
}

// Toggle wrapper that dims + freezes interaction when disabled (the base Toggle
// has no disabled state of its own).
function GatedToggle({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean
  disabled?: boolean
  onChange: (value: boolean) => void
}) {
  return (
    <div className={disabled ? 'opacity-40 pointer-events-none' : ''}>
      <Toggle checked={checked} onChange={onChange} />
    </div>
  )
}

// --- models (global) --------------------------------------------------------

function PetModels() {
  // Selectable models, derived from the connected providers in auth.json (same
  // source the global Default-model picker uses).
  const [models, setModels] = useState<PickModels>([])
  const [model, setModel] = useState<AgentModelRef | null>(() => loadPetModel())
  const [agentId, setAgentId] = useState<string>(() => loadPetExecutorAgentId())
  const [open, setOpen] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const mList = await window.electronAPI.agentListModels()
      setModels(mList.map((m) => ({ provider: m.provider, model: m.id, label: m.label })))
    } catch (err) {
      log.warn('[CanvasPetSettings] model list refresh failed', err)
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
    savePetModel(next)
    setModel(next)
    setOpen(false)
  }

  return (
    <SearchableBlock keywords="canvas pet model coding agent cli">
      <div className="space-y-3 pt-3">
        <ModelPrefRow
          label="Pet model"
          sublabel="The model the pet uses to observe, suggest, and run tasks."
          models={models}
          current={model}
          open={open}
          setOpen={setOpen}
          onPick={handlePick}
          noneLabel="Default model"
        />
        <div className="space-y-1.5">
          <div className="text-[10.5px] uppercase tracking-wider text-muted/70 font-semibold">Coding agent</div>
          <div className="text-[11px] text-muted -mt-1">The CLI the pet launches in a terminal to write the code.</div>
          <select
            value={agentId}
            onChange={(e) => { setAgentId(e.target.value); savePetExecutorAgentId(e.target.value) }}
            className="w-full bg-hover border border-strong rounded-md px-2 py-1.5 text-[12.5px] text-primary outline-none focus:border-agent-light/50"
          >
            <option value="">Let the pet choose</option>
            {AGENTS.map((a) => (
              <option key={a.id} value={a.id}>
                {a.displayName}
              </option>
            ))}
          </select>
        </div>
      </div>
    </SearchableBlock>
  )
}
