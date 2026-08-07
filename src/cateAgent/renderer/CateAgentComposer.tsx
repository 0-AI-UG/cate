import React from 'react'
import { ChatComposer, type ComposerPromptMode } from '../../renderer/chat/ChatComposer'
import { useComposerModels } from '../../renderer/chat/useComposerModels'
import { useComposerWorktrees } from '../../renderer/chat/useComposerWorktrees'
import { useSettingsStore } from '../../renderer/stores/settingsStore'
import { useUIStore } from '../../renderer/stores/uiStore'
import { sendDirectAgentMessage } from './cateAgentSend'
import { saveDefaultModel } from './codingModelPrefs'
import { buildFileMentions } from './codingDrop'
import {
  imageMimeForPath,
  readFileAsImage,
  readPathAsImage,
} from './CateAgentPanelChrome'
import {
  readCateFileLocation,
  readCateFilePaths,
} from '../../renderer/drag/fileDragPayload'
import type {
  CodingImageAttachment,
  CodingThinkingLevel,
} from '../../shared/types'
import { OrchestrationPreflight, useOrchestrationPreflight } from './OrchestrationPreflight'
import {
  CanvasModeSettings,
  DEFAULT_CANVAS_MODE_CONFIG,
  canvasModeEnableCommand,
  canvasModeSummary,
} from './CanvasModeSettings'
import {
  PlanModeSettings,
  DEFAULT_PLAN_MODE_CONFIG,
  planModeEnableCommand,
  planModeSummary,
} from './PlanModeSettings'

const draftKey = (wsId: string, hostPanelId?: string): string => (
  hostPanelId ? `cate.mainAgentDraft.${wsId}.${hostPanelId}` : `cate.mainAgentDraft.${wsId}`
)

function loadDraft(wsId: string, hostPanelId?: string): string {
  try {
    return localStorage.getItem(draftKey(wsId, hostPanelId)) ?? ''
  } catch {
    return ''
  }
}

function saveDraft(wsId: string, hostPanelId: string | undefined, value: string): void {
  try {
    if (value) localStorage.setItem(draftKey(wsId, hostPanelId), value)
    else localStorage.removeItem(draftKey(wsId, hostPanelId))
  } catch {
    // Draft persistence is best-effort.
  }
}

/** Composer for the new-chat surface. Existing chats use CodingChatView. */
export const CateAgentComposer: React.FC<{
  wsId: string
  rootPath: string
  chatId?: string | null
  onChatCreated?: (chatId: string) => void
  hostPanelId?: string
}> = ({
  wsId,
  rootPath,
  onChatCreated,
  hostPanelId,
}) => {
  const [draft, setDraft] = React.useState(() => loadDraft(wsId, hostPanelId))
  const [images, setImages] = React.useState<CodingImageAttachment[]>([])
  const [thinkingLevel, setThinkingLevel] = React.useState<CodingThinkingLevel | null>(null)
  const [promptMode, setPromptMode] = React.useState<ComposerPromptMode | null>(null)
  const [canvasModeConfig, setCanvasModeConfig] = React.useState(DEFAULT_CANVAS_MODE_CONFIG)
  const [planModeConfig, setPlanModeConfig] = React.useState(DEFAULT_PLAN_MODE_CONFIG)
  const [autoCompactionEnabled, setAutoCompactionEnabled] = React.useState(true)
  const [targetId, setTargetId] = React.useState<string | null>(null)
  const { models, refreshModels } = useComposerModels()
  const defaultModel = useSettingsStore((state) => state.agentDefaultModel)
  const { worktrees, onCreateWorktree, onCheckoutPr } = useComposerWorktrees({
    rootPath,
    workspaceId: wsId,
  })
  const orchestrationPreflight = useOrchestrationPreflight({
    active: promptMode === 'orchestrate',
    workspaceId: wsId,
    rootPath,
  })

  const updateDraft = React.useCallback((value: string) => {
    const normalized = value.replace(/\r\n?/g, '\n').replace(/^\n+/, '')
    setDraft(normalized)
    saveDraft(wsId, hostPanelId, normalized)
  }, [hostPanelId, wsId])

  const addImage = React.useCallback((image: CodingImageAttachment) => {
    setImages((current) => [...current, image])
  }, [])

  const handlePaste = React.useCallback(async (event: React.ClipboardEvent) => {
    for (const item of Array.from(event.clipboardData.items)) {
      if (item.kind !== 'file' || !item.type.startsWith('image/')) continue
      const file = item.getAsFile()
      if (!file) continue
      const image = await readFileAsImage(file)
      if (image) {
        addImage(image)
        event.preventDefault()
      }
    }
  }, [addImage])

  const handleDrop = React.useCallback(async (event: React.DragEvent) => {
    const paths = readCateFilePaths(event.dataTransfer)
    if (paths.length > 0) {
      event.preventDefault()
      const files: string[] = []
      for (const path of paths) {
        if (imageMimeForPath(path)) {
          const image = await readPathAsImage(path, wsId)
          if (image) addImage(image)
        } else {
          files.push(path)
        }
      }
      if (files.length > 0) {
        const mentions = buildFileMentions(files, readCateFileLocation(event.dataTransfer))
        updateDraft(draft ? `${draft}${draft.endsWith(' ') ? '' : ' '}${mentions} ` : `${mentions} `)
      }
      return
    }
    for (const file of Array.from(event.dataTransfer.files)) {
      const image = await readFileAsImage(file)
      if (image) addImage(image)
    }
  }, [addImage, draft, updateDraft, wsId])

  const submit = (): void => {
    const text = draft.trim()
    if (!text && images.length === 0) return
    const cwd = worktrees.find((worktree) => worktree.id === targetId)?.path
    const chatId = sendDirectAgentMessage(
      wsId,
      rootPath,
      text,
      targetId ?? undefined,
      {
        images: images.length > 0 ? images : undefined,
        thinkingLevel: thinkingLevel ?? undefined,
        autoCompactionEnabled,
        promptMode: promptMode ?? undefined,
        promptModeCommand: promptMode === 'plan'
          ? planModeEnableCommand(planModeConfig)
          : promptMode === 'canvas'
            ? canvasModeEnableCommand(canvasModeConfig)
            : undefined,
      },
      cwd,
      hostPanelId,
    )
    updateDraft('')
    setImages([])
    setPromptMode(null)
    onChatCreated?.(chatId)
  }
  const promptModeStatus = promptMode === 'orchestrate'
    ? orchestrationPreflight.status ?? undefined
    : promptMode === 'plan'
      ? planModeSummary(planModeConfig)
      : promptMode === 'canvas'
        ? canvasModeSummary(canvasModeConfig)
        : undefined
  const promptModeDetails = promptMode === 'orchestrate'
    ? <OrchestrationPreflight state={orchestrationPreflight} />
    : promptMode === 'plan'
      ? <PlanModeSettings config={planModeConfig} onChange={setPlanModeConfig} />
      : promptMode === 'canvas'
        ? <CanvasModeSettings config={canvasModeConfig} onChange={setCanvasModeConfig} />
        : undefined

  return (
    <ChatComposer
      draft={draft}
      onChange={updateDraft}
      onSubmit={submit}
      onStop={() => {}}
      disabled={false}
      running={false}
      placeholder="Ask the agent anything about this workspace…"
      images={images}
      onAddImage={addImage}
      onRemoveImage={(index) => setImages((current) => current.filter((_, i) => i !== index))}
      onPaste={handlePaste}
      onDrop={handleDrop}
      thinkingLevel={thinkingLevel}
      onPickThinkingLevel={setThinkingLevel}
      promptMode={promptMode}
      onPromptModeChange={setPromptMode}
      promptModeStatus={promptModeStatus}
      promptModeDetails={promptModeDetails}
      autoCompactionEnabled={autoCompactionEnabled}
      onToggleAutoCompaction={() => setAutoCompactionEnabled((value) => !value)}
      models={models}
      selectedModel={defaultModel}
      onModelMenuOpen={refreshModels}
      onPickModel={(model) => saveDefaultModel({ provider: model.provider, model: model.model })}
      onManageModels={() => useUIStore.getState().openSettings('cate agent')}
      worktrees={worktrees}
      selectedWorktreeId={targetId}
      onPickWorktree={setTargetId}
      worktreeMenuHeading="Work in…"
      rootPath={rootPath}
      onCreateWorktree={onCreateWorktree}
      onCheckoutPr={onCheckoutPr}
    />
  )
}
