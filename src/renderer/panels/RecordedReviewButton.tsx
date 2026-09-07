import React, { useEffect, useRef, useState } from 'react'
import type { AgentChangeRecord } from '../../shared/agentChanges'
import type { AgentId } from '../../shared/agents'
import { useAppStore } from '../stores/appStore'
import { inspectReviewAgents, launchReviewAgent, trackReviewAgent, unavailableReviewAgents } from '../lib/review/reviewAgent'
import { useDismissableLayer } from '../ui/Popover'
import { AgentPickerPopover, ReviewActionButton, type AgentChoice } from './ReviewControls'

export function recordedReviewPrompt(records: AgentChangeRecord[], panelId?: string): string {
  return ['Review only the recorded agent edits below. These are historical reported edits, not the current working-tree diff. Other agents may have changed the checkout since capture. Do not attribute unrelated Git changes to this review. Report findings without editing files. Fragments and unavailable patches are incomplete evidence; do not invent missing context.',
    ...records.flatMap((record) => record.files.map((file) => `\n${record.agentId}: ${file.path} (${file.coverage})\n${file.patch ?? file.hunks.map((hunk) => hunk.lines.filter((line) => line.kind !== 'meta').map((line) => `${line.kind === 'add' ? '+' : line.kind === 'delete' ? '-' : ' '}${line.text}`).join('\n')).join('\n')}`)),
    ...(panelId ? [`When finished reporting your findings, mark the Cate review complete by running: cate panel set ${panelId}\nThen run: cate review complete`] : []),
  ].join('\n')
}

export function RecordedReviewButton({ records, cwd, workspaceId, panelId, working = false }: { records: AgentChangeRecord[]; cwd: string; workspaceId: string; panelId: string; working?: boolean }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [choices, setChoices] = useState<AgentChoice[] | null>(null)
  const [agentId, setAgentId] = useState<AgentId | null>(null)
  const content = useRef<HTMLDivElement>(null)
  useDismissableLayer({ open: open && !busy, contentRef: content, onDismiss: () => setOpen(false) })
  useEffect(() => {
    if (!open) return
    let active = true
    setChoices(null); setError(''); setAgentId(null)
    const root = useAppStore.getState().getWorkspace(workspaceId)?.rootPath
    void inspectReviewAgents(cwd, workspaceId, root).then((options) => {
      if (!active) return
      setChoices(options); setAgentId(options.find((option) => option.ready)?.agent.id ?? null)
    }).catch((cause) => { if (active) { setChoices(unavailableReviewAgents()); setError(String(cause)) } })
    return () => { active = false }
  }, [open, cwd, workspaceId])
  const launch = async () => {
    if (!agentId || busy || working) return
    const prompt = recordedReviewPrompt(records, panelId)
    setBusy(true); setError('')
    try {
      const launched = await launchReviewAgent(workspaceId, panelId, cwd, prompt, 'Review changes', agentId)
      if (!launched) return
      trackReviewAgent(workspaceId, panelId, launched)
      setOpen(false)
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not start review') }
    finally { setBusy(false) }
  }
  return <div ref={content} className="relative">
    <ReviewActionButton label="Review in terminal" disabled={!records.some((r) => r.files.length) || busy || working} onClick={() => setOpen(!open)} />
    {open && <AgentPickerPopover action={{ kind: 'review' }} choices={choices} selectedAgentId={agentId} busy={busy} onSelect={setAgentId} onClose={() => !busy && setOpen(false)} onConfirm={() => void launch()} />}
    {error && <p role="alert" className="text-xs text-red-400">{error}</p>}
  </div>
}
