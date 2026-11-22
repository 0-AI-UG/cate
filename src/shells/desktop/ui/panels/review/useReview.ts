// Per-client state and agent selection for recorded-edit reviews.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { setClientSetting, useClientSetting } from '../../kernel/settings'
import { useAgentAvailability } from '../../services/agents'
import { usePanelView } from '../../client/document'
import type { RecordedFileSummary, ReviewAgentChoice, ReviewDisplay, ReviewOp, ReviewSnapshot } from '@panels/review/contract'
import type { PanelRecord } from '@workspace/document/contract'

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

export interface ReviewTerminal { title: string; index: number; panel?: PanelRecord }

export const sourcePanelId = (file: RecordedFileSummary, source?: string) =>
  (source && file.panelIds.includes(source) ? source : file.panelIds[0]) ?? ''
export const terminalTitle = (file: RecordedFileSummary, id: string, terminals: ReadonlyMap<string, ReviewTerminal>) =>
  terminals.get(id)?.title ?? file.panelTitles?.[id] ?? (id ? 'Closed terminal' : 'Unknown terminal')
export const recordedEditKey = (file: RecordedFileSummary) => JSON.stringify([file.recordId, file.path])
export const terminalGroupKey = (id: string) => `terminal:${id}`
export const terminalFileKey = (id: string, path: string) => JSON.stringify([terminalGroupKey(id), path])

export function useReviewView(workspaceId: string, panelId: string, snapshot: ReviewSnapshot) {
  const display: ReviewDisplay = {
    split: useClientSetting('reviewSplitDiff'),
    wordDiff: useClientSetting('reviewWordDiff'),
    wrap: useClientSetting('reviewWrapLines'),
  }
  const [pages, setPages] = usePanelView(workspaceId, panelId, 'diffPages', NO_PAGES)
  const [keys, setKeys] = usePanelView(workspaceId, panelId, 'expandedFiles', NO_KEYS)
  const expanded = useMemo(() => new Set(keys), [keys])
  const [groups, setGroups] = usePanelView(workspaceId, panelId, 'collapsedGroups', NO_KEYS)
  const collapsedGroups = useMemo(() => new Set(groups), [groups])
  const [fileFilter, setFileFilter] = usePanelView(workspaceId, panelId, 'fileFilter', '')
  const [focusedFile, setFocusedFile] = usePanelView<string | undefined>(workspaceId, panelId, 'focusedFile', undefined)
  const [revealSeq, setRevealSeq] = usePanelView(workspaceId, panelId, 'revealSeq', 0)
  const reveal = snapshot.reveal
  const source = snapshot.review.agentChanges?.panelId
  useEffect(() => {
    if (!reveal || reveal.seq === revealSeq) return
    const matching = snapshot.recorded.files.filter((file) => file.path === reveal.path)
    if (!matching.length) return
    setRevealSeq(reveal.seq)
    setFocusedFile(reveal.path)
    if (fileFilter) setFileFilter('')
    const terminals = new Set(matching.map((file) => sourcePanelId(file, source)))
    const next = [...new Set([...keys, ...[...terminals].map((id) => terminalFileKey(id, reveal.path))])]
    if (next.length !== keys.length) setKeys(next)
    const groupKeys = new Set([...terminals].map(terminalGroupKey))
    const nextGroups = groups.filter((key) => !groupKeys.has(key))
    if (nextGroups.length !== groups.length) setGroups(nextGroups)
  }, [source, reveal, revealSeq, keys, groups, fileFilter, snapshot.recorded.files, setRevealSeq, setFocusedFile, setKeys, setGroups, setFileFilter])
  return {
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
