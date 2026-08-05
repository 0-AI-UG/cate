// =============================================================================
// CodingChatView — render + drive ONE pi coding chat.
//
// Extracted verbatim from CateAgentPanel's per-chat half so the same surface can be
// reused outside the panel (e.g. the sidebar). All per-chat state, effects and
// handlers now live in the headless `useCodingChat` hook; this component is the
// bundled layout that renders the transcript AND composer together. A future
// split layout can call the same hook to render them separately.
//
// Multi-chat bookkeeping (which chats are open, readiness, the session
// registry, worktree/model MENU DATA) stays in the host and is threaded in via
// props: the composer's model + worktree menus are host-owned, and the
// model-picker open state is controlled so the host's readiness banner can open
// it. Per-chat readiness (`sessionReady`/`readyTick`) is derived from the host's
// readyByKey ref, so it too arrives as a prop.
// =============================================================================

import { useState } from 'react'
import { ChatThread } from './ChatThread'
import { ChatComposer } from '../../renderer/chat/ChatComposer'
import { ExtensionDialog, ExtensionWidget, QueueBadges } from './CateAgentPanelChrome'
import { useCodingChat, type CodingChatComposerExtras } from './useCodingChat'
import type { CodingSlashCommand } from '../../shared/types'
import { CateAgentEmptyState } from './CateAgentEmptyState'
import { OrchestrationPreflight, useOrchestrationPreflight } from './OrchestrationPreflight'
import {
  CanvasModeSettings,
  DEFAULT_CANVAS_MODE_CONFIG,
  canvasModeEnableCommand,
  canvasModeSummary,
  canvasModeUpdateCommand,
  type CanvasModeConfig,
} from './CanvasModeSettings'
import {
  PlanModeSettings,
  DEFAULT_PLAN_MODE_CONFIG,
  planModeEnableCommand,
  planModeSummary,
  planModeUpdateCommand,
  type PlanModeConfig,
} from './PlanModeSettings'

export type { CodingChatComposerExtras }

export interface CodingChatViewProps {
  /** The pi session this view renders. Null during the brief window before the
   *  host has resolved an active chat — the empty-state composer shows then,
   *  matching the pre-extraction behaviour. */
  agentKey: string | null
  workspaceId: string
  rootPath: string
  /** Namespaces the ChatThread scroll-memory key so mounting the SAME agentKey
   *  on two surfaces never collides. Defaults to 'panel'. */
  surface?: string
  /** Per-chat pi readiness (host's readyByKey[agentKey]). Polling effects bail
   *  until true. */
  sessionReady: boolean
  /** Host counter bumped whenever any chat's readiness flips — preserves the
   *  polling effects' re-run semantics. */
  readyTick: number
  /** Persist pi's learned on-disk session file onto host bookkeeping + the
   *  durable coding chat. */
  onSessionFile: (agentKey: string, file: string) => void
  /** Slash-command list for this chat (host-fetched) + a request to refresh it
   *  when the "/" popup opens. */
  commands: CodingSlashCommand[]
  onSlashOpen: () => void
  /** Controlled model-picker open state (the readiness banner opens it). */
  modelPickerOpen: boolean
  onModelPickerOpenChange: (open: boolean) => void
  composerExtras: CodingChatComposerExtras
}

export function CodingChatView({
  agentKey,
  workspaceId,
  rootPath,
  surface = 'panel',
  sessionReady,
  readyTick,
  onSessionFile,
  commands,
  onSlashOpen,
  modelPickerOpen,
  onModelPickerOpenChange,
  composerExtras,
}: CodingChatViewProps) {
  const { refreshModels, openProviderSettings } = composerExtras
  const [canvasModeConfigByAgent, setCanvasModeConfigByAgent] = useState<Record<string, CanvasModeConfig>>({})
  const [planModeConfigByAgent, setPlanModeConfigByAgent] = useState<Record<string, PlanModeConfig>>({})
  const canvasModeConfig = agentKey
    ? canvasModeConfigByAgent[agentKey] ?? DEFAULT_CANVAS_MODE_CONFIG
    : DEFAULT_CANVAS_MODE_CONFIG
  const planModeConfig = agentKey
    ? planModeConfigByAgent[agentKey] ?? DEFAULT_PLAN_MODE_CONFIG
    : DEFAULT_PLAN_MODE_CONFIG

  const {
    messages,
    running,
    retry,
    forkMap,
    onFork,
    onEditResend,
    onImplementPlan,
    onRefinePlan,
    onClearAndImplement,
    onAbortRetry,
    scrollKeyBase,
    composerProps,
    readiness,
    composerPlaceholder,
    onDragOver,
    onDrop,
    currentUiRequest,
    onUiResponse,
    extensionWidgets,
    steeringQueue,
    followUpQueue,
    configurePromptMode,
  } = useCodingChat({
    agentKey,
    workspaceId,
    rootPath,
    sessionReady,
    readyTick,
    onSessionFile,
    commands,
    onSlashOpen,
    modelPickerOpen,
    onModelPickerOpenChange,
    promptModeCommands: {
      plan: planModeEnableCommand(planModeConfig),
      canvas: canvasModeEnableCommand(canvasModeConfig),
    },
    composerExtras,
  })
  const orchestrationPreflight = useOrchestrationPreflight({
    active: composerProps.promptMode === 'orchestrate',
    workspaceId,
    rootPath,
  })
  const updateCanvasModeConfig = (next: CanvasModeConfig): void => {
    if (agentKey) {
      setCanvasModeConfigByAgent((current) => ({ ...current, [agentKey]: next }))
    }
    void configurePromptMode('canvas', canvasModeUpdateCommand(next))
  }
  const updatePlanModeConfig = (next: PlanModeConfig): void => {
    if (agentKey) {
      setPlanModeConfigByAgent((current) => ({ ...current, [agentKey]: next }))
    }
    void configurePromptMode('plan', planModeUpdateCommand(next))
  }
  const promptModeStatus = composerProps.promptMode === 'orchestrate'
    ? orchestrationPreflight.status ?? undefined
    : composerProps.promptMode === 'plan'
      ? planModeSummary(planModeConfig)
      : composerProps.promptMode === 'canvas'
        ? canvasModeSummary(canvasModeConfig)
        : undefined
  const promptModeDetails = composerProps.promptMode === 'orchestrate'
    ? <OrchestrationPreflight state={orchestrationPreflight} />
    : composerProps.promptMode === 'plan'
      ? <PlanModeSettings config={planModeConfig} onChange={updatePlanModeConfig} />
      : composerProps.promptMode === 'canvas'
        ? <CanvasModeSettings config={canvasModeConfig} onChange={updateCanvasModeConfig} />
        : undefined

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div
      className="relative flex-1 flex flex-col min-h-0"
      data-filedrop="cateAgent"
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      {readiness.kind !== 'ok' && readiness.kind !== 'loading' ? (
        <div className="px-3 py-2 bg-agent/10 border-b border-agent/30 flex items-center gap-2 text-[12px] text-primary">
          <span className="flex-1 truncate" title={readiness.error}>
            {readiness.message}
          </span>
          {/* A missing model is fixed at the composer's model pill, not in
              provider settings — send the user to the control that fixes
              the thing the banner is complaining about. */}
          {readiness.kind === 'noModel' ? (
            <button
              onClick={() => { void refreshModels(); onModelPickerOpenChange(true) }}
              className="px-2 py-1 rounded-md bg-agent hover:bg-agent-light text-white text-[11px] font-medium shrink-0"
            >
              Pick model
            </button>
          ) : (
            <button
              onClick={openProviderSettings}
              className="px-2 py-1 rounded-md bg-agent hover:bg-agent-light text-white text-[11px] font-medium shrink-0"
            >
              {readiness.kind === 'needsReauth' ? 'Reconnect' : 'Set up provider'}
            </button>
          )}
        </div>
      ) : null}

      {/* Retry status is now shown inline in the chat thread */}
      <ExtensionWidget widgets={extensionWidgets} placement="aboveEditor" />
      <QueueBadges steering={steeringQueue} followUp={followUpQueue} />

      {messages.length === 0 ? (
        <CateAgentEmptyState>
          <ChatComposer
            {...composerProps}
            promptModeStatus={promptModeStatus}
            promptModeDetails={promptModeDetails}
            placeholder={composerPlaceholder ?? 'Ask the agent anything about this workspace…'}
          />
        </CateAgentEmptyState>
      ) : (
        <>
          <ChatThread
            scrollKey={`${surface}:${scrollKeyBase}`}
            messages={messages}
            running={running}
            forkMap={forkMap}
            onFork={onFork}
            onEditResend={onEditResend}
            onImplementPlan={onImplementPlan}
            onRefinePlan={onRefinePlan}
            onClearAndImplement={onClearAndImplement}
            retry={retry}
            onAbortRetry={onAbortRetry}
          />
          <ExtensionWidget widgets={extensionWidgets} placement="belowEditor" />
          {currentUiRequest && (
            <div className="px-3 pt-2">
              <ExtensionDialog request={currentUiRequest} onRespond={onUiResponse} />
            </div>
          )}
          <div className="px-3 py-2 shrink-0">
            <ChatComposer
              {...composerProps}
              promptModeStatus={promptModeStatus}
              promptModeDetails={promptModeDetails}
              placeholder={composerPlaceholder}
            />
          </div>
        </>
      )}
    </div>
  )
}
