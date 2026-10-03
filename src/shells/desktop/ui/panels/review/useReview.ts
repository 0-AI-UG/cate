// View-side state of a review: diffs fetched on demand from the session, the
// agent picker, and how this client shows the review. Diffs never ride in the
// snapshot; a new `diffEpoch` or a change of this client's full-files display
// refetches the ones this view loaded, a new comparison drops them.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { clientUi } from '@kernel/interaction'
import { setClientSetting, useClientSetting } from '../../kernel/settings'
import { clientStateFor } from '@client/document'
import { usePanelView } from '../../client/document'
import type { AgentId } from '@services/agents/contract'
import type { GitFileDiff } from '@workspace/repository/contract'
import type { DiffOptions, ReviewAgentChoice, ReviewDisplay, ReviewOp, ReviewSnapshot } from '@panels/review/contract'

export type ReviewSend = (op: ReviewOp) => Promise<unknown>

const errorText = (cause: unknown, fallback: string) => (cause instanceof Error && cause.message ? cause.message : fallback)

export interface ReviewDiffs {
  diffs: Record<string, GitFileDiff>
  errors: Record<string, string>
  /** Loads a diff once. */
  load(path: string): void
  /** Loads it again with a different op (large, more context, full file). */
  reload(path: string, op: ReviewOp): void
}

/** `allLines`: this client shows whole files. */
export function useReviewDiffs(send: ReviewSend, snapshot: ReviewSnapshot | null, allLines: boolean): ReviewDiffs {
  const [diffs, setDiffs] = useState<Record<string, GitFileDiff>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const key = snapshot ? JSON.stringify([snapshot.review.repoPath, snapshot.review.spec]) : ''
  const epoch = snapshot?.diffEpoch ?? 0
  const keyRef = useRef(key)
  const loaded = useRef(new Map<string, ReviewOp>())
  const inFlight = useRef(new Set<string>())
  const allLinesRef = useRef(allLines)
  allLinesRef.current = allLines

  const fetchDiff = useCallback((path: string, op: ReviewOp) => {
    const forKey = keyRef.current
    loaded.current.set(path, op)
    inFlight.current.add(path)
    const options: DiffOptions | undefined = op.kind === 'diff' && allLinesRef.current ? { ...op.options, allLines: true } : undefined
    send(options ? { ...op, options } as ReviewOp : op).then((diff) => {
      if (keyRef.current !== forKey) return
      setDiffs((prev) => ({ ...prev, [path]: diff as GitFileDiff }))
      setErrors((prev) => {
        if (!(path in prev)) return prev
        const { [path]: _cleared, ...rest } = prev
        return rest
      })
    }, (cause) => {
      if (keyRef.current === forKey) setErrors((prev) => ({ ...prev, [path]: errorText(cause, `Could not load ${path}`) }))
    }).finally(() => inFlight.current.delete(path))
  }, [send])

  useEffect(() => {
    if (keyRef.current === key) return
    keyRef.current = key
    loaded.current.clear()
    inFlight.current.clear()
    setDiffs({})
    setErrors({})
  }, [key])

  // Refetch what this view shows; the options that loaded it stay in force
  // through the session's persisted expansion and context.
  const last = useRef({ epoch, allLines })
  useEffect(() => {
    if (last.current.epoch === epoch && last.current.allLines === allLines) return
    last.current = { epoch, allLines }
    for (const path of loaded.current.keys()) fetchDiff(path, { kind: 'diff', path })
  }, [epoch, allLines, fetchDiff])

  const load = useCallback((path: string) => {
    if (loaded.current.has(path) || inFlight.current.has(path)) return
    fetchDiff(path, { kind: 'diff', path })
  }, [fetchDiff])

  const reload = useCallback((path: string, op: ReviewOp) => fetchDiff(path, op), [fetchDiff])

  return { diffs, errors, load, reload }
}

export interface AgentPicker {
  open: boolean
  choices: ReviewAgentChoice[] | null
  selected: AgentId | null
  select(agentId: AgentId): void
  show(): void
  close(): void
}

/** Asks the session which agent CLIs are ready, and keeps the choice. */
export function useAgentPicker(send: ReviewSend): AgentPicker {
  const [open, setOpen] = useState(false)
  const [choices, setChoices] = useState<ReviewAgentChoice[] | null>(null)
  const [selected, setSelected] = useState<AgentId | null>(null)
  const show = useCallback(() => {
    setOpen(true)
    setChoices(null)
    setSelected(null)
    void send({ kind: 'reviewAgents' }).then((result) => {
      const list = result as ReviewAgentChoice[]
      setChoices(list)
      setSelected(list.find((choice) => choice.ready)?.agentId ?? null)
    }, () => setChoices([]))
  }, [send])
  return { open, choices, selected, select: setSelected, show, close: useCallback(() => setOpen(false), []) }
}

/** Runs an op whose failure the person should see. */
export async function sendOrShow(send: ReviewSend, op: ReviewOp, fallback: string): Promise<unknown> {
  try {
    return await send(op)
  } catch (cause) {
    clientUi().showError(errorText(cause, fallback))
    return undefined
  }
}

export interface ReviewView {
  display: ReviewDisplay
  updateDisplay(patch: Partial<ReviewDisplay>): void
  /** Git paths, or `${recordId}:${path}` for recorded agent edits. */
  collapsed: ReadonlySet<string>
  setCollapsed(keys: string[]): void
  toggleCollapsed(key: string): void
}

const DISPLAY_SETTINGS = {
  split: 'reviewSplitDiff',
  wordDiff: 'reviewWordDiff',
  wrap: 'reviewWrapLines',
  fullFile: 'reviewFullFiles',
  advancedPreview: 'reviewImagePreviews',
} as const satisfies Record<keyof ReviewDisplay, string>

const NO_KEYS: string[] = []

/** How this client shows the review: display from its client settings, the
 *  collapsed files from its client state. A newly focused file is expanded. */
export function useReviewView(workspaceId: string, panelId: string, focusedFile: string | undefined): ReviewView {
  const display: ReviewDisplay = {
    split: useClientSetting('reviewSplitDiff'),
    wordDiff: useClientSetting('reviewWordDiff'),
    wrap: useClientSetting('reviewWrapLines'),
    fullFile: useClientSetting('reviewFullFiles'),
    advancedPreview: useClientSetting('reviewImagePreviews'),
  }
  const [keys, setKeys] = usePanelView(workspaceId, panelId, 'collapsedFiles', NO_KEYS)
  const collapsed = useMemo(() => new Set(keys), [keys])

  useEffect(() => {
    if (!focusedFile) return
    const current = clientStateFor(workspaceId)?.getSnapshot().panelViews[panelId]?.collapsedFiles as string[] | undefined
    const next = current?.filter((key) => key !== focusedFile && !key.endsWith(`:${focusedFile}`))
    if (current && next && next.length !== current.length) setKeys(next)
  }, [workspaceId, panelId, focusedFile, setKeys])

  return {
    display,
    updateDisplay: (patch) => {
      for (const name of Object.keys(patch) as Array<keyof ReviewDisplay>) setClientSetting(DISPLAY_SETTINGS[name], patch[name]!)
    },
    collapsed,
    setCollapsed: setKeys,
    toggleCollapsed: (key) => setKeys(collapsed.has(key) ? keys.filter((item) => item !== key) : [...keys, key]),
  }
}
