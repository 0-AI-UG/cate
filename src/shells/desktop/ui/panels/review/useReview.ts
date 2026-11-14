// Per-client state and agent selection for recorded-edit reviews.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { setClientSetting, useClientSetting } from '../../kernel/settings'
import { useAgentAvailability } from '../../services/agents'
import { usePanelView } from '../../client/document'
import type { RecordedFileSummary, ReviewAgentChoice, ReviewDisplay, ReviewOp, ReviewSnapshot } from '@panels/review/contract'

export type ReviewSend = (op: ReviewOp) => Promise<unknown>

export interface AgentPicker {
  open: boolean
  choices: ReviewAgentChoice[] | null
  show(): void
  close(): void
}

/** The launcher's shared runtime availability stays subscribed while the
 * review is mounted. Opening the flyout never starts another inspection. */
export function useAgentPicker(workspaceId: string): AgentPicker {
  const availability = useAgentAvailability(workspaceId)
  const [open, setOpen] = useState(false)
  const choices = useMemo(() => availability?.snapshot
    ? availability.types.map(({ agentId, ready }) => ({ agentId, ready }))
    : availability?.error ? [] : null, [availability])
  return { open, choices, show: useCallback(() => setOpen(true), []), close: useCallback(() => setOpen(false), []) }
}

const DISPLAY_SETTINGS = {
  split: 'reviewSplitDiff',
  wordDiff: 'reviewWordDiff',
  wrap: 'reviewWrapLines',
} as const satisfies Record<keyof ReviewDisplay, string>


const NO_KEYS: string[] = []
const NO_PAGES: Record<string, number> = {}

export type ReviewGrouping = 'commit' | 'pullRequest' | 'conversation'
export const recordedGroupKey = (file: RecordedFileSummary, grouping: ReviewGrouping = 'commit') => {
  if (grouping === 'conversation') return `session:${file.agentId}:${file.sessionId ?? file.recordId}`
  const commit = file.commit?.hash ?? (file.uncommitted ? 'uncommitted' : 'unattributed')
  return grouping === 'pullRequest' ? `pr:${file.prNumber ?? 'unknown'}:${commit}` : commit
}

export function useReviewView(workspaceId: string, panelId: string, snapshot: ReviewSnapshot) {
  const display: ReviewDisplay = {
    split: useClientSetting('reviewSplitDiff'),
    wordDiff: useClientSetting('reviewWordDiff'),
    wrap: useClientSetting('reviewWrapLines'),
  }
  const [pages, setPages] = usePanelView(workspaceId, panelId, 'diffPages', NO_PAGES)
  const [grouping, setGrouping] = usePanelView<ReviewGrouping>(workspaceId, panelId, 'grouping', 'commit')
  const [keys, setKeys] = usePanelView(workspaceId, panelId, 'expandedFiles', NO_KEYS)
  const expanded = useMemo(() => new Set(keys), [keys])
  const [groups, setGroups] = usePanelView(workspaceId, panelId, 'collapsedGroups', NO_KEYS)
  const collapsedGroups = useMemo(() => new Set(groups), [groups])
  const [fileFilter, setFileFilter] = usePanelView(workspaceId, panelId, 'fileFilter', '')
  const [focusedFile, setFocusedFile] = usePanelView<string | undefined>(workspaceId, panelId, 'focusedFile', undefined)
  const [revealSeq, setRevealSeq] = usePanelView(workspaceId, panelId, 'revealSeq', 0)
  const reveal = snapshot.reveal
  useEffect(() => {
    if (!reveal || reveal.seq === revealSeq) return
    const matching = snapshot.recorded.files.filter((file) => file.path === reveal.path)
    if (!matching.length) return
    setRevealSeq(reveal.seq)
    setFocusedFile(reveal.path)
    const next = [...new Set([...keys, ...matching.map((file) => `${file.recordId}:${file.path}`)])]
    if (next.length !== keys.length) setKeys(next)
    const groupKeys = new Set(matching.map((file) => recordedGroupKey(file, grouping)))
    const nextGroups = groups.filter((key) => !groupKeys.has(key))
    if (nextGroups.length !== groups.length) setGroups(nextGroups)
  }, [grouping, reveal, revealSeq, keys, groups, snapshot.recorded.files, setRevealSeq, setFocusedFile, setKeys, setGroups])
  return {
    grouping, setGrouping,
    pageFor: (key: string) => pages[key] ?? 0,
    setPage: (key: string, page: number) => setPages({ ...pages, [key]: page }),
    display,
    updateDisplay: (patch: Partial<ReviewDisplay>) => {
      for (const name of Object.keys(patch) as Array<keyof ReviewDisplay>) setClientSetting(DISPLAY_SETTINGS[name], patch[name]!)
    },
    expanded,
    collapseAll: () => setKeys([]),
    toggleExpanded: (key: string) => setKeys(expanded.has(key) ? keys.filter((item) => item !== key) : [...keys, key]),
    collapsedGroups,
    toggleGroup: (key: string) => setGroups(collapsedGroups.has(key) ? groups.filter((item) => item !== key) : [...groups, key]),
    fileFilter,
    setFileFilter,
    focusedFile,
    revealSeq,
  }
}
