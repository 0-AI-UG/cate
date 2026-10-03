import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createDocument, type WorkspaceDocument } from '@workspace/document/contract'
import { installMockClientUi } from '@kernel/interaction/testing'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const h = vi.hoisted(() => ({ doc: null as unknown as WorkspaceDocument }))
vi.mock('../../client/document', async () => {
  const { useState } = await import('react')
  return {
    useDocument: (_ws: string, select: (doc: WorkspaceDocument) => unknown) => select(h.doc),
    usePanelView: (_ws: string, _panel: string, _key: string, fallback: unknown) => useState(fallback),
  }
})
vi.mock('@client/document', () => ({ documentStoreFor: () => null, clientStateFor: () => null }))
vi.mock('../../workspace/repository', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../workspace/repository')>()),
  useRepositoryUi: () => ({ root: '/repo' }),
  useWorktrees: () => [],
}))
const pickPanelPlace = vi.hoisted(() => vi.fn(async () => ({ kind: 'existing', panelId: 't1' })))
vi.mock('@client/host', async (importOriginal) => ({ ...(await importOriginal<typeof import('@client/host')>()), pickPanelPlace }))

import { registerPanelDefinitions } from '@client/host'
import { PANEL_DEFINITIONS } from '@panels/definitions'
import ReviewView from './ReviewView'

registerPanelDefinitions(PANEL_DEFINITIONS)
import { type ReviewOp, type ReviewSnapshot } from '@panels/review/contract'

const file = { path: 'src/a.ts', status: 'modified' as const, additions: 1, deletions: 0, binary: false, staged: false, working: true }
const untracked = { ...file, path: 'new.ts', status: 'added' as const, untracked: true }
const diff = {
  path: 'src/a.ts', binary: false, tooLarge: false, byteLength: 1,
  hunks: [{ header: '@@', oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [{ kind: 'add' as const, text: 'return safe()', oldLine: null, newLine: 1 }] }],
}

function gitSnapshot(patch: Partial<ReviewSnapshot> = {}): ReviewSnapshot {
  return {
    review: { repoPath: '/repo', spec: { kind: 'uncommitted' }, notes: [] },
    comparison: { spec: { kind: 'uncommitted' }, resolvedBase: null, resolvedTarget: null, currentBranch: 'main', files: [file, untracked], additions: 1, deletions: 0 },
    diffEpoch: 1,
    recorded: { loading: false, error: null, files: [] },
    loading: false, busy: false, agentBusy: false, error: null, notRepository: false, branches: [], commits: [],
    ...patch,
  }
}

let host: HTMLDivElement
let root: Root
let send: ReturnType<typeof vi.fn<(op: ReviewOp) => Promise<unknown>>>

function render(snapshot: ReviewSnapshot) {
  act(() => root.render(<ReviewView workspaceId="ws" panelId="review" record={{ id: 'review', type: 'review', title: 'Review', fields: {} }} session={null as never} send={send} snapshot={snapshot} visible focused={false} />))
}
const flush = () => act(async () => { await Promise.resolve() })
const button = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!

beforeEach(() => {
  h.doc = createDocument()
  send = vi.fn(async (op: ReviewOp) => {
    if (op.kind === 'diff') return diff
    if (op.kind === 'recordedDiff') return { path: op.path, hunks: diff.hunks, additions: 1, deletions: 0, coverage: 'patch' }
    if (op.kind === 'reviewAgents') return [{ agentId: 'codex', ready: true }]
    if (op.kind === 'applyCommand') return 'git apply PATCH'
    return undefined
  })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

it('fetches diffs on demand and refetches them when the epoch moves', async () => {
  installMockClientUi()
  render(gitSnapshot({ comparison: { ...gitSnapshot().comparison!, files: [file] } }))
  await flush()
  expect(send).toHaveBeenCalledWith({ kind: 'diff', path: 'src/a.ts' })
  expect(host.textContent).toContain('return safe()')
  send.mockClear()
  render(gitSnapshot({ comparison: { ...gitSnapshot().comparison!, files: [file] }, diffEpoch: 2 }))
  await flush()
  expect(send).toHaveBeenCalledWith({ kind: 'diff', path: 'src/a.ts' })
})

it('says the folder is not a Git repository instead of showing an error', async () => {
  installMockClientUi()
  render(gitSnapshot({ comparison: null, notRepository: true }))
  await flush()
  expect(host.querySelector('[data-review-not-repository]')?.textContent).toBe('This folder is not a Git repository')
  expect(host.textContent).not.toContain('No changes in this comparison')
})

it('collapses a file on this client only, without an op', async () => {
  installMockClientUi()
  render(gitSnapshot({ comparison: { ...gitSnapshot().comparison!, files: [file] } }))
  await flush()
  send.mockClear()
  act(() => (host.querySelector('[aria-label="Collapse file"]') as HTMLButtonElement).click())
  expect(host.querySelector('[aria-label="Expand file"]')).not.toBeNull()
  expect(host.textContent).not.toContain('return safe()')
  expect(send).not.toHaveBeenCalled()
})

it('confirms before discarding and passes whether the file is untracked', async () => {
  const ui = installMockClientUi({ confirm: vi.fn(async () => true) })
  render(gitSnapshot())
  await flush()
  const discards = host.querySelectorAll<HTMLButtonElement>('button[aria-label="Discard working changes"]')
  await act(async () => { discards[1].click() })
  expect(ui.confirm).toHaveBeenCalledWith(expect.stringContaining('new.ts'))
  expect(send).toHaveBeenCalledWith({ kind: 'discard', path: 'new.ts', untracked: true })

  ui.confirm.mockResolvedValueOnce(false)
  send.mockClear()
  await act(async () => { discards[0].click() })
  expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'discard' }))
})

it('copies the apply command and opens a created pull request through ClientUi', async () => {
  const ui = installMockClientUi()
  send.mockImplementation(async (op: ReviewOp) => (op.kind === 'createPullRequest' ? { url: 'https://example.test/pr/1' } : op.kind === 'applyCommand' ? 'git apply PATCH' : op.kind === 'diff' ? diff : undefined))
  render(gitSnapshot({ review: { ...gitSnapshot().review, spec: { kind: 'branch', base: 'origin/main', target: 'main' } } }))
  await act(async () => { button('Create pull request').click() })
  expect(ui.openExternal).toHaveBeenCalledWith('https://example.test/pr/1')
  act(() => button('More review options').click())
  await act(async () => { [...host.querySelectorAll('button')].find((b) => b.textContent === 'Copy git apply command')!.click() })
  expect(ui.writeClipboard).toHaveBeenCalledWith('git apply PATCH')
})

it('shows recorded agent edits and fetches their hunks from the session', async () => {
  installMockClientUi()
  h.doc = { ...createDocument(), panels: { term: { id: 'term', type: 'terminal', title: 'Terminal 1', fields: {} } } }
  render(gitSnapshot({
    review: { ...gitSnapshot().review, agentChanges: { panelId: 'term' } },
    comparison: null,
    recorded: { loading: false, error: null, files: [{ recordId: 'rec', agentId: 'codex', source: 'terminal', panelIds: ['term'], path: 'src/a.ts', additions: 1, deletions: 0, coverage: 'patch', lineCount: 1 }] },
  }))
  await flush()
  expect(send).toHaveBeenCalledWith({ kind: 'recordedDiff', recordId: 'rec', path: 'src/a.ts' })
  expect(host.textContent).toContain('return safe()')
  expect(button('Go to Terminal 1')).not.toBeNull()
  act(() => button('Remove Terminal 1 filter').click())
  expect(send).toHaveBeenCalledWith({ kind: 'updateFilter', patch: { panelId: null, sessionId: null, turnId: null } })
})

it('starts a terminal review with the agent the person picks', async () => {
  installMockClientUi()
  send.mockImplementation(async (op: ReviewOp) => (op.kind === 'reviewAgents' ? [{ agentId: 'codex', ready: true }] : op.kind === 'reviewWithAgent' ? true : op.kind === 'diff' ? diff : undefined))
  render(gitSnapshot())
  await act(async () => { button('Review in terminal').click() })
  expect(send).toHaveBeenCalledWith({ kind: 'reviewAgents' })
  await act(async () => { [...host.querySelectorAll('button')].find((b) => b.textContent === 'Start review')!.click() })
  expect(pickPanelPlace).toHaveBeenCalledWith({ workspaceId: 'ws', panelType: 'terminal', availability: 'both', sourcePanelId: 'review' })
  expect(send).toHaveBeenCalledWith({ kind: 'reviewWithAgent', agentId: 'codex', terminalPanelId: 't1' })
})
