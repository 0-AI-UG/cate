// =============================================================================
// AISetupDialog — Wizard-style modal for first-time AI tool setup in a project.
// Appears when showAISetupDialog is true in uiStore.
// =============================================================================

import React, { useCallback, useEffect, useState } from 'react'
import log from '../lib/logger'
import {
  Check,
  X,
  ChevronRight,
  Terminal,
  Cpu,
  Diamond,
  MousePointer,
  Code,
  Loader2,
  Sparkles,
  FileText,
  Folder,
  Bot,
} from 'lucide-react'
import type { AIToolId, AIConfigFile } from '../../shared/types'
import { useUIStore } from '../stores/uiStore'
import { useAppStore } from '../stores/appStore'
import { useAIConfigStore } from '../stores/aiConfigStore'

// -----------------------------------------------------------------------------
// Tool metadata
// -----------------------------------------------------------------------------

interface ToolMeta {
  id: AIToolId
  name: string
  cliCommand: string
  Icon: React.FC<any>
}

const TOOLS: ToolMeta[] = [
  { id: 'claude',   name: 'Claude Code',   cliCommand: 'claude',   Icon: Sparkles },
  { id: 'codex',    name: 'OpenAI Codex',  cliCommand: 'codex',    Icon: Cpu },
  { id: 'gemini',   name: 'Gemini CLI',    cliCommand: 'gemini',   Icon: Diamond },
  { id: 'cursor',   name: 'Cursor',        cliCommand: 'cursor',   Icon: MousePointer },
  { id: 'opencode', name: 'OpenCode',      cliCommand: 'opencode', Icon: Code },
]

// -----------------------------------------------------------------------------
// Props
// -----------------------------------------------------------------------------

interface AISetupDialogProps {
  workspaceId: string
}

// -----------------------------------------------------------------------------
// Step types
// -----------------------------------------------------------------------------

type Step = 1 | 2 | 3 | 4

// Per-tool detection result
interface DetectionResult {
  id: AIToolId
  installed: boolean
  checking: boolean
}

// Per-tool config file preview (from store scan results)
interface FilePreviewEntry {
  toolId: AIToolId
  toolName: string
  file: AIConfigFile
}

// -----------------------------------------------------------------------------
// Helper: icon for a file path
// -----------------------------------------------------------------------------

function FileEntryIcon({ isDirectory }: { isDirectory?: boolean }) {
  if (isDirectory) {
    return <Folder size={14} className="text-white/40 flex-shrink-0" />
  }
  return <FileText size={14} className="text-white/40 flex-shrink-0" />
}

// -----------------------------------------------------------------------------
// Component
// -----------------------------------------------------------------------------

export function AISetupDialog({ workspaceId }: AISetupDialogProps) {
  const setShowAISetupDialog = useUIStore((s) => s.setShowAISetupDialog)

  const rootPath = useAppStore((s) => {
    const ws = s.workspaces.find((w) => w.id === workspaceId)
    return ws?.rootPath ?? ''
  })

  const { scan, createAllForTool, tools: scannedTools, scanning } = useAIConfigStore()

  // ---------------------------------------------------------------------------
  // Wizard state
  // ---------------------------------------------------------------------------

  const [step, setStep] = useState<Step>(1)

  // Step 1 — detection results
  const [detectionResults, setDetectionResults] = useState<DetectionResult[]>(
    TOOLS.map((t) => ({ id: t.id, installed: false, checking: true })),
  )
  const [detectionDone, setDetectionDone] = useState(false)

  // Step 2 — which tools to configure (pre-check installed ones)
  const [selectedTools, setSelectedTools] = useState<Set<AIToolId>>(new Set())

  // Step 4 — which tools were actually created
  const [createdTools, setCreatedTools] = useState<AIToolId[]>([])
  const [creating, setCreating] = useState(false)

  // ---------------------------------------------------------------------------
  // Step 1: detect installed CLI tools
  // ---------------------------------------------------------------------------

  useEffect(() => {
    let cancelled = false

    async function detect() {
      const results: DetectionResult[] = []

      for (const tool of TOOLS) {
        let installed = false
        try {
          const path = await window.electronAPI.shellWhich(tool.cliCommand)
          installed = path !== null
        } catch {
          installed = false
        }
        if (!cancelled) {
          results.push({ id: tool.id, installed, checking: false })
          setDetectionResults((prev) =>
            prev.map((r) => (r.id === tool.id ? { id: tool.id, installed, checking: false } : r)),
          )
        }
      }

      if (!cancelled) {
        setDetectionDone(true)
        const installedIds = new Set<AIToolId>(
          results.filter((r) => r.installed).map((r) => r.id),
        )
        setSelectedTools(installedIds)
      }
    }

    detect()
    return () => { cancelled = true }
  }, [])

  // ---------------------------------------------------------------------------
  // Step 2 → 3: scan workspace when moving to preview step
  // ---------------------------------------------------------------------------

  const handleGoToPreview = useCallback(async () => {
    if (rootPath) {
      await scan(rootPath)
    }
    setStep(3)
  }, [rootPath, scan])

  // ---------------------------------------------------------------------------
  // Step 3: build preview list from store scan results
  // ---------------------------------------------------------------------------

  const filePreviewEntries: FilePreviewEntry[] = React.useMemo(() => {
    if (!scannedTools) return []
    const entries: FilePreviewEntry[] = []
    for (const toolId of Array.from(selectedTools)) {
      const presence = scannedTools[toolId]
      if (!presence) continue
      const missing = presence.configFiles.filter((f) => !f.exists && !f.isDirectory)
      for (const file of missing) {
        entries.push({ toolId, toolName: presence.name, file })
      }
    }
    return entries
  }, [scannedTools, selectedTools])

  // ---------------------------------------------------------------------------
  // Step 3 → 4: create all files
  // ---------------------------------------------------------------------------

  const handleCreateAll = useCallback(async () => {
    if (!rootPath) return
    setCreating(true)
    const created: AIToolId[] = []
    for (const toolId of Array.from(selectedTools)) {
      try {
        await createAllForTool(toolId, rootPath)
        created.push(toolId)
      } catch (err) {
        log.error(`[AISetupDialog] createAllForTool failed for ${toolId}:`, err)
      }
    }
    setCreatedTools(created)
    setCreating(false)
    setStep(4)
  }, [rootPath, selectedTools, createAllForTool])

  // ---------------------------------------------------------------------------
  // Step 4: open AI Config panel and close dialog
  // ---------------------------------------------------------------------------

  const handleOpenAIConfig = useCallback(() => {
    setShowAISetupDialog(false)
    useUIStore.getState().setShowAIConfigDialog(true)
  }, [setShowAISetupDialog])

  const handleClose = useCallback(() => {
    setShowAISetupDialog(false)
  }, [setShowAISetupDialog])

  // Close on Escape
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') handleClose()
    }
    document.addEventListener('keydown', onKey, { capture: true })
    return () => document.removeEventListener('keydown', onKey, { capture: true })
  }, [handleClose])

  // ---------------------------------------------------------------------------
  // Render helpers
  // ---------------------------------------------------------------------------

  function StepIndicator({ current }: { current: Step }) {
    return (
      <div className="flex items-center gap-1 mb-6">
        {([1, 2, 3, 4] as Step[]).map((s) => (
          <React.Fragment key={s}>
            <div
              className={`w-2 h-2 rounded-full transition-colors ${
                s === current
                  ? 'bg-white/70'
                  : s < current
                  ? 'bg-white/30'
                  : 'bg-white/10'
              }`}
            />
            {s < 4 && <div className="w-4 h-px bg-white/10" />}
          </React.Fragment>
        ))}
      </div>
    )
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50"
      onClick={handleClose}
    >
      <div
        className="relative bg-[#1E1E24] border border-white/[0.08] rounded-2xl shadow-2xl w-full max-w-md mx-4 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Close button */}
        <button
          onClick={handleClose}
          className="absolute top-4 right-4 p-1 rounded-lg text-white/30 hover:text-white/70 hover:bg-white/[0.06] transition-colors"
          aria-label="Close"
        >
          <X size={16} />
        </button>

        <div className="p-6">
          <StepIndicator current={step} />

          {/* ------------------------------------------------------------------ */}
          {/* Step 1: Detect                                                       */}
          {/* ------------------------------------------------------------------ */}
          {step === 1 && (
            <>
              <h2 className="text-white/90 font-semibold text-lg mb-1">
                Detect AI Tools
              </h2>
              <p className="text-white/40 text-sm mb-5">
                Checking which AI CLI tools are installed on your system.
              </p>

              <div className="space-y-2">
                {TOOLS.map((tool) => {
                  const result = detectionResults.find((r) => r.id === tool.id)
                  const checking = result?.checking ?? true
                  const installed = result?.installed ?? false
                  return (
                    <div
                      key={tool.id}
                      className="flex items-center gap-3 px-3 py-2.5 rounded-lg bg-white/[0.03] border border-white/[0.06]"
                    >
                      <tool.Icon size={16} className="text-white/50 flex-shrink-0" />
                      <span className="text-sm text-white/80 flex-1">{tool.name}</span>
                      {checking ? (
                        <Loader2 size={14} className="text-white/30 animate-spin" />
                      ) : installed ? (
                        <span className="flex items-center gap-1 text-xs text-emerald-400/80">
                          <Check size={12} />
                          Installed
                        </span>
                      ) : (
                        <span className="text-xs text-white/25">Not found</span>
                      )}
                    </div>
                  )
                })}
              </div>

              <div className="mt-6 flex justify-end">
                <button
                  onClick={() => setStep(2)}
                  disabled={!detectionDone}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium bg-white/[0.08] text-white/80 hover:bg-white/[0.12] hover:text-white/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  Next
                  <ChevronRight size={14} />
                </button>
              </div>
            </>
          )}

          {/* ------------------------------------------------------------------ */}
          {/* Step 2: Select tools                                                 */}
          {/* ------------------------------------------------------------------ */}
          {step === 2 && (
            <>
              <h2 className="text-white/90 font-semibold text-lg mb-1">
                Select Tools to Configure
              </h2>
              <p className="text-white/40 text-sm mb-5">
                Choose which AI tools to set up configuration files for.
              </p>

              <div className="space-y-2">
                {TOOLS.map((tool) => {
                  const checked = selectedTools.has(tool.id)
                  const detection = detectionResults.find((r) => r.id === tool.id)
                  const isInstalled = detection?.installed ?? false

                  return (
                    <label
                      key={tool.id}
                      className="flex items-center gap-3 px-3 py-2.5 rounded-lg bg-white/[0.03] border border-white/[0.06] cursor-pointer hover:bg-white/[0.06] transition-colors"
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) => {
                          setSelectedTools((prev) => {
                            const next = new Set(prev)
                            if (e.target.checked) next.add(tool.id)
                            else next.delete(tool.id)
                            return next
                          })
                        }}
                        className="w-4 h-4 accent-white/70 flex-shrink-0"
                      />
                      <tool.Icon size={16} className="text-white/50 flex-shrink-0" />
                      <span className="text-sm text-white/80 flex-1">{tool.name}</span>
                      {isInstalled && (
                        <span className="text-xs text-emerald-400/60">Installed</span>
                      )}
                    </label>
                  )
                })}
              </div>

              <div className="mt-6 flex items-center justify-between">
                <button
                  onClick={() => setStep(1)}
                  className="text-sm text-white/35 hover:text-white/60 transition-colors"
                >
                  Back
                </button>
                <button
                  onClick={handleGoToPreview}
                  disabled={selectedTools.size === 0}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium bg-white/[0.08] text-white/80 hover:bg-white/[0.12] hover:text-white/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  {scanning ? (
                    <>
                      <Loader2 size={14} className="animate-spin" />
                      Scanning…
                    </>
                  ) : (
                    <>
                      Next
                      <ChevronRight size={14} />
                    </>
                  )}
                </button>
              </div>
            </>
          )}

          {/* ------------------------------------------------------------------ */}
          {/* Step 3: Preview                                                      */}
          {/* ------------------------------------------------------------------ */}
          {step === 3 && (
            <>
              <h2 className="text-white/90 font-semibold text-lg mb-1">
                Preview Files
              </h2>
              <p className="text-white/40 text-sm mb-5">
                The following files will be created in your project.
              </p>

              {filePreviewEntries.length === 0 ? (
                <div className="py-6 text-center text-sm text-white/30">
                  All configuration files already exist — nothing to create.
                </div>
              ) : (
                <div className="space-y-1 max-h-56 overflow-y-auto pr-1">
                  {filePreviewEntries.map(({ toolId, toolName, file }) => {
                    const toolMeta = TOOLS.find((t) => t.id === toolId)
                    const Icon = toolMeta?.Icon ?? Bot
                    return (
                      <div
                        key={`${toolId}:${file.relativePath}`}
                        className="flex items-center gap-2.5 px-3 py-2 rounded-lg bg-white/[0.03] border border-white/[0.06]"
                      >
                        <Icon size={13} className="text-white/35 flex-shrink-0" />
                        <span className="text-xs text-white/40 flex-shrink-0 w-20 truncate">
                          {toolName}
                        </span>
                        <FileEntryIcon isDirectory={file.isDirectory} />
                        <span className="text-xs text-white/70 font-mono truncate flex-1">
                          {file.relativePath}
                        </span>
                      </div>
                    )
                  })}
                </div>
              )}

              <div className="mt-6 flex items-center justify-between">
                <button
                  onClick={() => setStep(2)}
                  className="text-sm text-white/35 hover:text-white/60 transition-colors"
                >
                  Back
                </button>
                <button
                  onClick={filePreviewEntries.length === 0 ? () => setStep(4) : handleCreateAll}
                  disabled={creating}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium bg-white/[0.08] text-white/80 hover:bg-white/[0.12] hover:text-white/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  {creating ? (
                    <>
                      <Loader2 size={14} className="animate-spin" />
                      Creating…
                    </>
                  ) : filePreviewEntries.length === 0 ? (
                    <>
                      Continue
                      <ChevronRight size={14} />
                    </>
                  ) : (
                    <>
                      Create All
                      <Check size={14} />
                    </>
                  )}
                </button>
              </div>
            </>
          )}

          {/* ------------------------------------------------------------------ */}
          {/* Step 4: Done                                                         */}
          {/* ------------------------------------------------------------------ */}
          {step === 4 && (
            <>
              <div className="flex items-center justify-center w-10 h-10 rounded-full bg-emerald-500/10 border border-emerald-500/20 mb-4">
                <Check size={20} className="text-emerald-400" />
              </div>

              <h2 className="text-white/90 font-semibold text-lg mb-1">
                Setup Complete
              </h2>
              <p className="text-white/40 text-sm mb-5">
                {createdTools.length > 0
                  ? `Configuration files created for ${createdTools.length} tool${createdTools.length !== 1 ? 's' : ''}.`
                  : 'No new files were needed — everything was already configured.'}
              </p>

              {createdTools.length > 0 && (
                <div className="space-y-1.5 mb-5">
                  {createdTools.map((toolId) => {
                    const toolMeta = TOOLS.find((t) => t.id === toolId)
                    if (!toolMeta) return null
                    const Icon = toolMeta.Icon
                    return (
                      <div
                        key={toolId}
                        className="flex items-center gap-2.5 px-3 py-2 rounded-lg bg-emerald-500/[0.05] border border-emerald-500/[0.12]"
                      >
                        <Icon size={14} className="text-emerald-400/60 flex-shrink-0" />
                        <span className="text-sm text-white/70">{toolMeta.name}</span>
                        <Check size={12} className="text-emerald-400/70 ml-auto flex-shrink-0" />
                      </div>
                    )
                  })}
                </div>
              )}

              <div className="flex items-center gap-2">
                <button
                  onClick={handleOpenAIConfig}
                  className="flex-1 flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium bg-white/[0.08] text-white/80 hover:bg-white/[0.12] hover:text-white/90 transition-colors"
                >
                  <Bot size={14} />
                  Open AI Config Panel
                </button>
                <button
                  onClick={handleClose}
                  className="px-4 py-2 rounded-lg text-sm text-white/35 hover:text-white/60 hover:bg-white/[0.05] transition-colors"
                >
                  Close
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
