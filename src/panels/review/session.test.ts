import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ApiSessionContext } from '@kernel/api/contract'
import { createLogger } from '@kernel/log/contract'
import { isRpcError } from '@kernel/rpc/contract'
import { MAIN_WINDOW, type Json, type PanelRecord } from '@workspace/document/contract'
import { createDocumentService, type DocumentService } from '@workspace/document/runtime'
import type { RepoStatus } from '@workspace/repository/contract'
import type { AgentChangeRecord } from '@services/agents/contract'
import type { SessionKit, SessionStore } from '@panels/framework/runtime'
import type { ReviewNote, ReviewOp, ReviewSnapshot, ReviewState } from './contract'
import { ReviewSession, type ReviewSessionDeps } from './session'

const file = { path: 'src/a.ts', status: 'modified', additions: 1, deletions: 0, binary: false, staged: false, working: true }
const diff = {
  path: 'src/a.ts', binary: false, tooLarge: false, byteLength: 1, patch: 'PATCH',
  hunks: [{ header: '@@', oldStart: 1, oldLines: 1, newStart: 4, newLines: 1, lines: [{ kind: 'add' as const, text: 'return safe()', oldLine: null, newLine: 4 }] }],
}
const repoStatus = (files: string[]): RepoStatus => ({
  isRepo: true, branch: 'main', dirty: true, tracking: null, ahead: 0, behind: 0,
  files: files.map((p) => ({ path: p, index: ' ', working_dir: 'M' })), branches: [], worktrees: [],
})

let dir: string
let document: DocumentService
let stored: Json | undefined
let statusListeners: Array<(status: RepoStatus) => void>
let exitListeners: Array<(panelId: string) => void>
let records: AgentChangeRecord[]
let deps: ReviewSessionDeps
let repo: Record<string, ReturnType<typeof vi.fn>>
let session: ReviewSession

const snap = () => session.snapshot() as unknown as ReviewSnapshot
const saved = () => stored as unknown as ReviewState
const op = (value: ReviewOp) => session.handleOp(value, { clientId: 'c', connectionId: 1 })

function ctx(callerPanelId?: string): ApiSessionContext {
  return {
    caller: { kind: 'cli', id: 'caller', panelId: callerPanelId },
    method: 'cate.review.x',
    signal: new AbortController().signal,
    sticky: { get: () => undefined, set: () => {}, clear: () => {} },
    defaultTarget: () => undefined,
    invoke: async () => undefined,
    panelId: 'review',
  }
}

function makeSession(record: PanelRecord): ReviewSession {
  const store: SessionStore = { read: () => stored, write: (value) => { stored = value }, flush: async () => {} }
  const kit: SessionKit = {
    panelId: record.id, document, store, log: createLogger('test'),
    surface: async () => undefined, session: () => undefined,
  }
  return new ReviewSession(kit, record, deps)
}

async function start(fields: Record<string, Json> = { repoPath: '/repo' }): Promise<void> {
  const record: PanelRecord = { id: 'review', type: 'review', title: 'Review', fields }
  if (!document.get().panels.review) {
    document.apply({ kind: 'addPanel', record, at: { to: 'stack', dock: { windowId: MAIN_WINDOW, layoutId: 'main' }, stackId: 's1' } })
  }
  session = makeSession(document.get().panels.review)
  await session.start()
}

beforeEach(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'review-session-'))
  document = createDocumentService({ file: path.join(dir, 'document.json'), debounceMs: 60_000 })
  stored = undefined
  statusListeners = []
  exitListeners = []
  records = []
  repo = {
    compare: vi.fn(async () => ({ spec: { kind: 'uncommitted' }, files: [file], additions: 1, deletions: 0, resolvedBase: 'base', resolvedTarget: 'target', currentBranch: 'feature' })),
    fileDiff: vi.fn(async () => diff),
    fileContent: vi.fn(async ({ side }: { side: string }) => ({ exists: true, size: 1, base64: side })),
    stage: vi.fn(async () => {}),
    unstage: vi.fn(async () => {}),
    discardFile: vi.fn(async () => {}),
    commit: vi.fn(async () => {}),
    log: vi.fn(async () => []),
    branchList: vi.fn(async () => ({ current: 'main', branches: [] })),
    readStatus: vi.fn(async () => ({ files: [], current: 'main', tracking: null, ahead: 0, behind: 0 })),
    createPr: vi.fn(async () => ({ ok: true, created: true, url: 'https://example.test/pr/1' })),
    refreshStatus: vi.fn(),
  }
  deps = {
    root: '/repo',
    repository: {
      ...(repo as unknown as ReviewSessionDeps['repository']),
      watchStatus: (_cwd, listener) => {
        statusListeners.push(listener)
        return () => { statusListeners = statusListeners.filter((l) => l !== listener) }
      },
    },
    files: { trash: vi.fn(async () => {}), writeText: vi.fn(async () => {}) },
    agents: {
      readChanges: vi.fn(async () => ({ revision: String(records.length), records })),
      readiness: vi.fn(async () => [{ agentId: 'codex' as const, ready: true }]),
      start: vi.fn(async () => ({ panelId: 'worker' })),
      send: vi.fn(async () => {}),
      onExit: (listener) => {
        exitListeners.push(listener)
        return () => { exitListeners = exitListeners.filter((l) => l !== listener) }
      },
      threadIdOf: () => undefined,
    },
  }
  await start()
  await vi.waitFor(() => expect(snap().comparison).not.toBeNull())
})

afterEach(() => {
  session.dispose('shutdown')
  document.dispose()
  rmSync(dir, { recursive: true, force: true })
})

it('stages, unstages and discards through the repository and refreshes the comparison', async () => {
  const before = repo.compare.mock.calls.length
  await op({ kind: 'stage', path: 'src/a.ts' })
  await op({ kind: 'unstage', path: 'src/a.ts' })
  await op({ kind: 'discard', path: 'src/a.ts', untracked: false })
  await op({ kind: 'discard', path: 'new.ts', untracked: true })
  expect(repo.stage).toHaveBeenCalledWith({ cwd: '/repo', path: 'src/a.ts' })
  expect(repo.unstage).toHaveBeenCalledWith({ cwd: '/repo', path: 'src/a.ts' })
  expect(repo.discardFile).toHaveBeenCalledWith({ cwd: '/repo', path: 'src/a.ts' })
  expect(deps.files.trash).toHaveBeenCalledWith(path.join('/repo', 'new.ts'))
  expect(repo.refreshStatus).toHaveBeenCalledTimes(4)
  expect(repo.compare.mock.calls.length - before).toBe(4)
  expect(snap()).toMatchObject({ busy: false, error: null })
})

it('reports file operation failures in the snapshot and fails the op', async () => {
  repo.stage.mockRejectedValueOnce(new Error('index locked'))
  await expect(op({ kind: 'stage', path: 'src/a.ts' })).rejects.toSatisfy((e) => isRpcError(e, 'rejected') && (e as Error).message === 'index locked')
  expect(snap()).toMatchObject({ busy: false, error: 'index locked' })
})

it('adds, toggles and resolves notes, persisting them in the session file', async () => {
  const note = await op({ kind: 'addNote', note: { path: 'src/a.ts', side: 'new', line: 4, context: 'return safe()', body: 'Check', severity: 'warning' } }) as ReviewNote
  expect(note).toMatchObject({ author: 'human', status: 'open', resolvedBase: 'base', resolvedTarget: 'target' })
  await op({ kind: 'toggleNote', noteId: note.id })
  expect(saved().notes![0].status).toBe('resolved')
  await op({ kind: 'toggleNote', noteId: note.id })
  expect(await op({ kind: 'resolveNote', noteId: note.id.slice(0, 4) })).toBe(note.id)
  expect(snap().review.notes![0].status).toBe('resolved')
  await expect(op({ kind: 'resolveNote', noteId: 'missing' })).rejects.toSatisfy((e) => isRpcError(e, 'rejected') && (e as Error).message === 'review-note-not-found')
})

it('adds agent notes through cate.review.note.add on the live diff', async () => {
  const human = await op({ kind: 'addNote', note: { path: 'src/a.ts', side: 'new', line: 4, context: 'return safe()', body: 'Human', severity: 'warning' } }) as ReviewNote
  const note = await session.handleApi!('note.add', { file: 'src/a.ts', side: 'new', line: 4, body: 'Agent', severity: 'warning' }, ctx('reviewer'))
  expect(note).toMatchObject({ author: 'agent', agentPanelId: 'reviewer', context: 'return safe()', contextHash: human.contextHash })
  expect(saved().notes).toHaveLength(2)
  await expect(session.handleApi!('note.add', { file: 'src/a.ts', side: 'new', line: 9, body: 'x', severity: 'warning' }, ctx('reviewer')))
    .rejects.toThrow('line-not-in-diff')
  await expect(session.handleApi!('note.add', { file: 'other.ts', side: 'new', line: 1, body: 'x', severity: 'warning' }, ctx('reviewer')))
    .rejects.toThrow('file-not-in-review')
})

it('inspects the comparison for cate.review.inspect', async () => {
  const result = await session.handleApi!('inspect', {}, ctx())
  expect(result).toMatchObject({ panelId: 'review', repoPath: '/repo', resolvedBase: 'base', files: [file], notes: [] })
})

it('persists the history choice, never how a reader shows files', async () => {
  await op({ kind: 'diff', path: 'src/a.ts', options: { fullFile: true } })
  await op({ kind: 'update', patch: { showHistory: true } })
  expect(saved()).toEqual(expect.objectContaining({ showHistory: true }))
  expect(saved()).not.toHaveProperty('expandedFiles')
  expect(saved()).not.toHaveProperty('contextLines')
})

it('loads a diff as the asking client shows it', async () => {
  await op({ kind: 'diff', path: 'src/a.ts', options: { contextLines: 20 } })
  expect(repo.fileDiff).toHaveBeenLastCalledWith({ cwd: '/repo', spec: { kind: 'uncommitted' }, path: 'src/a.ts', contextLines: 20, allowLarge: false })
  await op({ kind: 'diff', path: 'src/a.ts', options: { fullFile: true } })
  expect(repo.fileDiff).toHaveBeenLastCalledWith({ cwd: '/repo', spec: { kind: 'uncommitted' }, path: 'src/a.ts', contextLines: 999_999, allowLarge: true })
})

it('fetches diffs on demand and relocates line notes to them', async () => {
  await op({ kind: 'addNote', note: { path: 'src/a.ts', side: 'new', line: 9, context: 'return safe()', body: 'Moved', severity: 'info' } })
  expect(snap()).not.toHaveProperty('diffs')
  expect(await op({ kind: 'diff', path: 'src/a.ts' })).toEqual(diff)
  expect(repo.fileDiff).toHaveBeenLastCalledWith({ cwd: '/repo', spec: { kind: 'uncommitted' }, path: 'src/a.ts', contextLines: 3, allowLarge: false })
  expect(saved().notes![0]).toMatchObject({ line: 4, outdated: false })
})

it('bumps the diff epoch when a refresh invalidates diffs', async () => {
  const epoch = snap().diffEpoch
  await op({ kind: 'refresh' })
  expect(snap().diffEpoch).toBe(epoch + 1)
})

it('loads every line as context for a client showing whole files', async () => {
  await op({ kind: 'diff', path: 'src/a.ts', options: { allLines: true } })
  expect(repo.fileDiff).toHaveBeenLastCalledWith({ cwd: '/repo', spec: { kind: 'uncommitted' }, path: 'src/a.ts', contextLines: 999_999, allowLarge: false })
})

it('returns the git apply command and the created pull request instead of touching the client', async () => {
  expect(await op({ kind: 'applyCommand' })).toContain('PATCH')
  expect(await op({ kind: 'createPullRequest' })).toEqual({ url: 'https://example.test/pr/1' })
  expect(repo.createPr).toHaveBeenCalledWith({ path: '/repo', branch: 'feature' })
  await op({ kind: 'addNote', note: { path: 'src/a.ts', side: 'file', line: null, context: '', body: 'Check' } })
  await op({ kind: 'saveNotes', path: '/out/notes.md' })
  expect(deps.files.writeText).toHaveBeenCalledWith('/out/notes.md', expect.stringContaining('Check'))
})

it('merges an open request, keeping local state, and reveals its file once', async () => {
  await op({ kind: 'update', patch: { showHistory: true } })
  expect(snap().reveal).toBeNull()
  await op({ kind: 'retarget', request: { spec: { kind: 'staged' }, focusedFile: 'src/a.ts' } })
  expect(saved()).toMatchObject({ spec: { kind: 'staged' }, showHistory: true })
  expect(saved()).not.toHaveProperty('focusedFile')
  const reveal = snap().reveal
  expect(reveal).toMatchObject({ path: 'src/a.ts' })
  await op({ kind: 'retarget', request: { spec: { kind: 'staged' }, focusedFile: 'src/a.ts' } })
  expect(snap().reveal!.seq).toBeGreaterThan(reveal!.seq)
  await vi.waitFor(() => expect(repo.compare).toHaveBeenLastCalledWith({ cwd: '/repo', spec: { kind: 'staged' } }))
})

it('switches worktrees by id and follows the checkout in the record', async () => {
  document.apply({ kind: 'setWorktree', worktree: { id: 'main', path: '/repo', color: 'green', status: 'ready' } })
  document.apply({ kind: 'setWorktree', worktree: { id: 'feature', path: '/feature', color: 'blue', status: 'ready' } })
  await op({ kind: 'addNote', note: { path: 'src/a.ts', side: 'file', line: null, context: '', body: 'Main note' } })
  await op({ kind: 'switchWorktree', worktreeId: 'feature' })
  expect(saved().repoPath).toBe('/feature')
  expect(saved().notes).toEqual([])
  expect(document.get().panels.review).toMatchObject({ worktreeId: 'feature', fields: { repoPath: '/feature' } })
  await op({ kind: 'switchWorktree', worktreeId: null })
  expect(saved().repoPath).toBe('/repo')
  expect(saved().notes![0].body).toBe('Main note')
})

it('restores its persisted review instead of the record request', async () => {
  await op({ kind: 'setSpec', spec: { kind: 'staged' } })
  session.dispose('shutdown')
  await start({ repoPath: '/repo', request: { spec: { kind: 'unstaged' } } })
  expect(snap().review.spec).toEqual({ kind: 'staged' })
})

it('inspects across a concurrent status refresh but rejects a changed comparison', async () => {
  let answer!: (value: unknown) => void
  repo.compare.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve }))
  const inspected = session.inspect()
  void session.refresh()
  answer({ files: [file], additions: 1, deletions: 0, resolvedBase: 'base', resolvedTarget: 'target' })
  await expect(inspected).resolves.toMatchObject({ files: [file] })

  repo.compare.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve }))
  const changed = session.inspect()
  await op({ kind: 'setSpec', spec: { kind: 'branch', base: 'main', target: 'HEAD' } })
  answer({ files: [file], additions: 1, deletions: 0, resolvedBase: 'base', resolvedTarget: 'target' })
  await expect(changed).rejects.toThrow('review-changed')
})

it('launches a reviewer and lets only that reviewer complete the review', async () => {
  expect(await op({ kind: 'reviewWithAgent', agentId: 'codex' })).toBe(true)
  expect(deps.agents.start).toHaveBeenCalledWith('review', expect.objectContaining({ agentId: 'codex', title: 'Review changes', prompt: expect.stringContaining('cate review inspect') }))
  expect(saved().agentReview).toMatchObject({ terminalPanelId: 'worker', status: 'working' })
  expect(await op({ kind: 'reviewWithAgent', agentId: 'codex' })).toBe(false)
  await expect(session.handleApi!('complete', {}, ctx('reviewer'))).rejects.toThrow('review-agent-mismatch')
  await session.handleApi!('complete', {}, ctx('worker'))
  expect(saved().agentReview).toMatchObject({ terminalPanelId: 'worker', status: 'complete' })
})

it('marks a working review failed once its reviewer\'s terminal exited', async () => {
  await op({ kind: 'reviewWithAgent', agentId: 'codex' })
  for (const listener of exitListeners) listener('other')
  expect(snap().review.agentReview).toMatchObject({ status: 'working' })
  for (const listener of exitListeners) listener('worker')
  expect(snap().review.agentReview).toMatchObject({ status: 'failed', completedAt: expect.any(Number) })
})

it('sends open findings to the source agent and asks for another agent when it is gone', async () => {
  await op({ kind: 'retarget', request: { spec: { kind: 'uncommitted' }, sourceAgent: { panelId: 'term' } } })
  expect(await op({ kind: 'requestChanges' })).toBe('cancelled')
  await op({ kind: 'addNote', note: { path: 'src/a.ts', side: 'new', line: 4, context: 'return safe()', body: 'Fix it', severity: 'error' } })
  expect(await op({ kind: 'requestChanges' })).toBe('done')
  expect(deps.agents.send).toHaveBeenCalledWith('term', expect.stringContaining('Fix it'))
  vi.mocked(deps.agents.send).mockRejectedValueOnce(new Error('gone'))
  expect(await op({ kind: 'requestChanges' })).toBe('pick-agent')
  expect(await op({ kind: 'requestChanges', agentId: 'claude-code' })).toBe('done')
  expect(deps.agents.start).toHaveBeenLastCalledWith('review', expect.objectContaining({ agentId: 'claude-code', title: 'Address review findings' }))
})

it('lists recorded agent edits still changed in git, and serves their hunks on demand', async () => {
  const hunk = diff.hunks[0]
  records = [{
    id: 'rec', agentId: 'codex', sessionId: 's', turnId: 't', source: 'terminal', sourceId: 'term', panelId: 'term', cwd: '/repo',
    createdAt: '1', mode: 'operation',
    files: [
      { path: 'src/a.ts', hunks: [hunk], additions: 1, deletions: 0, coverage: 'patch' },
      { path: 'src/gone.ts', hunks: [hunk], additions: 1, deletions: 0, coverage: 'patch' },
    ],
  }]
  await op({ kind: 'selectComparison', comparison: 'agent' })
  expect(snap().recorded.loading).toBe(true)
  for (const listener of statusListeners) listener(repoStatus(['src/a.ts']))
  await vi.waitFor(() => expect(snap().recorded).toMatchObject({ loading: false, files: [{ recordId: 'rec', path: 'src/a.ts', panelIds: ['term'], lineCount: 1 }] }))
  expect(snap().recorded.files).toHaveLength(1)
  expect(await op({ kind: 'recordedDiff', recordId: 'rec', path: 'src/a.ts' })).toMatchObject({ hunks: [hunk] })
  await op({ kind: 'update', patch: { showHistory: true } })
  expect(snap().recorded.files).toHaveLength(2)
  await op({ kind: 'updateFilter', patch: { agentId: 'claude-code' } })
  expect(snap().recorded.files).toHaveLength(0)
  await op({ kind: 'updateFilter', patch: { agentId: null } })
  expect(saved().agentChanges).toEqual({})
})
