// =============================================================================
// CanvasCateAgentSettings — the Cate Agent's own settings section.
//
// The Cate Agent is always on; what's configurable is how it behaves:
//   - Automatic observations are per-workspace (.cate/cateAgent.json), so that
//     toggle acts on the selected workspace.
//   - Everything else (observation frequency, coding agent, parallel attempts) is
//     a global pref (settings.json) shared across workspaces.
//
// The model is the shared default (Settings → Providers) with a per-chat override
// in the composer, so there's no model control here. Every control is the shared
// settings kit (SettingRow / Toggle / Select / NumberInput).
// =============================================================================

import type { ReactNode } from 'react'
import { AGENTS } from '../../shared/agents'
import { useAppStore } from '../stores/appStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useUIStore } from '../stores/uiStore'
import { useCateAgentReady } from '../stores/providerReadinessStore'
import { useCateAgentWs } from '../../cateAgent/renderer/cateAgentStore'
import { cateAgentController } from '../../cateAgent/renderer/cateAgentController'
import { SettingRow, Toggle, Select, NumberInput, SearchableBlock } from './SettingsComponents'

export function CanvasCateAgentSettings() {
  const gate = useCateAgentReady()
  const ready = gate === 'ok'
  return (
    <div className="flex flex-col gap-1">
      {gate === 'noProvider' && <NoProviderNotice />}
      {gate === 'needsReauth' && <ReauthNotice />}
      <CateAgentObservations />
      {/* Job controls resolve nothing without a usable provider — dim them. The
          model is the shared default, configured in Settings → Providers. */}
      <Gated disabled={!ready}>
        <CateAgentJobs />
      </Gated>
    </div>
  )
}

// The Cate Agent hides from the canvas whenever it has no usable provider (see
// providerReadinessStore / CanvasToolbar). These notices are the one place that
// explains why and links to the fix.
function ProviderNotice({ text, action }: { text: string; action: string }) {
  return (
    <SearchableBlock keywords="cate agent provider connect reconnect sign in required expired">
      <div className="my-2 px-3 py-2.5 rounded-md bg-agent/10 border border-agent/30 flex items-center gap-3">
        <p className="flex-1 text-xs text-primary">{text}</p>
        <button
          type="button"
          onClick={() => useUIStore.getState().openSettings('providers')}
          className="px-2 py-1 rounded-md bg-agent hover:bg-agent-light text-white text-[11px] font-medium shrink-0"
        >
          {action}
        </button>
      </div>
    </SearchableBlock>
  )
}

// No provider connected at all.
function NoProviderNotice() {
  return (
    <ProviderNotice
      text="No AI provider is connected. The Cate Agent needs one to observe your workspace and run tasks, and stays hidden until you connect one."
      action="Open Providers"
    />
  )
}

// A provider is configured but its sign-in has expired (OAuth token can't refresh).
function ReauthNotice() {
  return (
    <ProviderNotice
      text="Your AI provider sign-in has expired. The Cate Agent is hidden until you reconnect it."
      action="Reconnect"
    />
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
