import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createDocument, type WorkspaceDocument } from '@workspace/document/contract'
import { installMockClientUi } from '../../../../../test/clientUi'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const h = vi.hoisted(() => ({ doc: null as unknown as WorkspaceDocument, availability: { snapshot: {}, types: [{ agentId: 'codex', ready: true }], error: null } }))
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
vi.mock('../../services/agents', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../services/agents')>()), useAgentAvailability: () => h.availability }))
const pickPanelPlace = vi.hoisted(() => vi.fn(async () => ({ kind: 'existing', panelId: 't1' })))
const revealPanel = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('@client/host', async (importOriginal) => ({ ...(await importOriginal<typeof import('@client/host')>()), pickPanelPlace, revealPanel }))

import { registerPanelDefinitions } from '@client/host'
import { PANEL_DEFINITIONS } from '@panels/definitions'
import ReviewView from './ReviewView'

registerPanelDefinitions(PANEL_DEFINITIONS)
import { type ReviewOp, type ReviewSnapshot } from '@panels/review/contract'

const diff = {
  path: 'src/a.ts', binary: false, tooLarge: false, byteLength: 1,
  hunks: [{ header: '@@', oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [{ kind: 'add' as const, text: 'return safe()', oldLine: null, newLine: 1 }] }],
}

function agentSnapshot(patch: Partial<ReviewSnapshot> = {}): ReviewSnapshot {
  return {
    review: { repoPath: '/repo', agentChanges: {} },
    recorded: { loading: false, error: null, panels: [{ id: 't1', title: 'Implement auth' }], files: [{ recordId: 'rec', agentId: 'codex', panelIds: ['t1'], path: 'src/a.ts', additions: 1, deletions: 0, coverage: 'patch', lineCount: 1 }] },
    loading: false, agentBusy: false, error: null, reveal: null,
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
const button = (label: string) => document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!
beforeEach(() => {
  pickPanelPlace.mockClear()
  revealPanel.mockClear()
  h.availability = { snapshot: {}, types: [{ agentId: 'codex', ready: true }], error: null }
  h.doc = createDocument()
  send = vi.fn(async (op: ReviewOp) => {
    if (op.kind === 'recordedDiff') return { path: op.path, hunks: diff.hunks, additions: 1, deletions: 0, coverage: 'patch', page: op.page ?? 0, pageCount: 1, totalLines: 1 }
    if (op.kind === 'reviewAgents') return [{ agentId: 'codex', ready: true }]
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

it('opens in recorded agent changes without Git comparison or filter dropdowns', async () => {
  installMockClientUi()
  render(agentSnapshot())
  await flush()
  expect(host.querySelector('select[aria-label="Comparison"]')).toBeNull()
  expect(button('Filters')).toBeNull()
  expect(button('Refresh')).toBeNull()
  expect(button('Filter by agent')).toBeNull()
  expect(host.querySelector('[aria-label="Group recorded edits"]')).toBeNull()
  expect(send).not.toHaveBeenCalled()
  expect(button('Expand src/a.ts')).not.toBeNull()
  expect(host.textContent).not.toContain('return safe()')
  await act(async () => button('Expand src/a.ts').click())
  expect(send).toHaveBeenCalledWith({ kind: 'recordedDiff', recordId: 'rec', path: 'src/a.ts', page: 0 })
  expect(host.textContent).toContain('return safe()')
  expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'diff' }))
})

it('shows initial loading without an empty state, and no animation for each pending file', async () => {
  installMockClientUi()
  render(agentSnapshot({ recorded: { loading: true, error: null, files: [], panels: [] } }))
  expect(host.textContent).toContain('Loading recorded changes')
  expect(host.textContent).not.toContain('No active agent edits')
  send.mockImplementation(() => new Promise(() => {}))
  render(agentSnapshot())
  await flush()
  await act(async () => button('Expand src/a.ts').click())
  expect(host.textContent).toContain('Loading recorded diff')
  expect(host.querySelector('[data-review-file] .animate-spin')).toBeNull()
})

it('shows diff loading only after a file is clicked', async () => {
  installMockClientUi()
  send.mockImplementation(() => new Promise(() => {}))
  render(agentSnapshot())
  await flush()
  expect(send).not.toHaveBeenCalled()
  expect(host.textContent).not.toContain('Loading recorded diff')
  await act(async () => button('Expand src/a.ts').click())
  expect(send).toHaveBeenCalledWith({ kind: 'recordedDiff', recordId: 'rec', path: 'src/a.ts', page: 0 })
  expect(host.textContent).toContain('Loading recorded diff')
})

it('shows one chip for the narrowest context and clears the whole scope', async () => {
  installMockClientUi()
  const snapshot = agentSnapshot()
  const scoped = { ...snapshot, review: { ...snapshot.review, agentChanges: { panelId: 't1', sessionId: 'session', turnId: 'turn' } } }
  render(scoped)
  expect(button('Clear review scope: This turn')).not.toBeNull()
  expect(button('Clear review scope: This conversation')).toBeNull()
  expect(button('Clear review scope: Implement auth')).toBeNull()
  await act(async () => button('Clear review scope: This turn').click())
  expect(send).toHaveBeenCalledWith({ kind: 'updateFilter', patch: { panelId: null, sessionId: null, turnId: null } })
  render(snapshot)
  expect(host.querySelector('[aria-label^="Clear review scope"]')).toBeNull()
  expect(host.querySelector('[data-review-scope-label]')?.textContent).toBe('All terminals')
})

it('searches both terminal titles and file paths without changing the scope', async () => {
  installMockClientUi()
  const snapshot = agentSnapshot()
  render({ ...snapshot, recorded: { ...snapshot.recorded, files: [snapshot.recorded.files[0],
    { ...snapshot.recorded.files[0], recordId: 'other', path: 'src/b.ts', panelIds: ['other'], panelTitles: { other: 'Update tests' }, agentId: 'claude-code' },
  ] } })
  const find = () => host.querySelector<HTMLInputElement>('input[aria-label="Search files and terminals"]')
  expect(find()).toBeNull()
  act(() => button('Search files and terminals').click())
  const input = find()!
  expect(document.activeElement).toBe(input)
  const search = (value: string) => act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  search('UPDATE TESTS')
  expect(button('Expand src/b.ts')).not.toBeNull()
  expect(button('Expand src/a.ts')).toBeNull()
  search('src/a')
  expect(button('Expand src/a.ts')).not.toBeNull()
  expect(button('Expand src/b.ts')).toBeNull()
  expect(input.closest('[role="toolbar"]')).not.toBeNull()
  act(() => button('Close review search').click())
  expect(find()).toBeNull()
  expect(button('Expand src/b.ts')).not.toBeNull()
  expect(send).not.toHaveBeenCalled()
})

it('scopes Review to the selected terminal and shows its panel title in the toolbar', async () => {
  installMockClientUi()
  h.doc = { ...createDocument(), panels: { t1: { id: 't1', type: 'terminal', title: 'Live terminal', fields: {} } } }
  const snapshot = agentSnapshot()
  render(snapshot)
  await act(async () => button('Select source panel on canvas').click())
  expect(pickPanelPlace).toHaveBeenCalledWith({ workspaceId: 'ws', panelType: 'terminal', availability: 'existing', sourcePanelId: 'review' })
  expect(send).toHaveBeenCalledWith({ kind: 'updateFilter', patch: { panelId: 't1', sessionId: null, turnId: null } })
  act(() => button('Collapse Live terminal').click())
  expect(button('Expand src/a.ts')).toBeNull()
  render({ ...snapshot, review: { ...snapshot.review, agentChanges: { panelId: 't1' } } })
  const chip = button('Clear review scope: Live terminal')
  expect(chip.closest('[role="toolbar"]')).not.toBeNull()
  const label = host.querySelector<HTMLElement>('[data-review-scope-label]')!
  expect(label.textContent).toBe('Live terminal')
  expect(label).toBe(button('Go to Live terminal'))
  await act(async () => label.click())
  expect(revealPanel).toHaveBeenCalledWith('ws', 't1')
  expect(pickPanelPlace).toHaveBeenCalledTimes(1)
  expect(host.querySelector('[data-review-summary]')?.textContent).toBe('1 file · 1 edit')
  expect(host.querySelector('[data-review-group]')).toBeNull()
  expect(button('Expand src/a.ts')).not.toBeNull()
  h.doc = createDocument()
  render({ ...snapshot, review: { ...snapshot.review, agentChanges: { panelId: 't1' } } })
  expect(host.querySelector('[data-review-scope-label]')?.textContent).toBe('Implement auth')
  expect(button('Go to Implement auth')).toBeNull()
  expect(button('Expand src/a.ts')).not.toBeNull()
})

it('summarizes distinct terminals and paths alongside the total recorded edits', () => {
  installMockClientUi()
  const snapshot = agentSnapshot()
  const file = snapshot.recorded.files[0]
  render({ ...snapshot, recorded: { ...snapshot.recorded, files: [
    file, { ...file, recordId: 'same-path', panelIds: ['t2'] },
    { ...file, recordId: 'another-path', path: 'src/b.ts' },
  ] } })
  expect(host.querySelector('[data-review-summary]')?.textContent).toBe('2 terminals · 2 files · 3 edits')
  act(() => button('Search files and terminals').click())
  expect(host.querySelector('[data-review-summary]')).toBeNull()
  act(() => button('Close review search').click())
  expect(host.querySelector('[data-review-summary]')).not.toBeNull()
})

it('lists every file without fetching diffs until a row is opened', async () => {
  installMockClientUi()
  const files = Array.from({ length: 21 }, (_, index) => ({ ...agentSnapshot().recorded.files[0], recordId: `rec${index}`, path: `file${index}.ts` }))
  render(agentSnapshot({ recorded: { ...agentSnapshot().recorded, files } }))
  await flush()
  expect(host.querySelectorAll('[data-review-file]')).toHaveLength(21)
  expect(button('Next files page')).toBeNull()
  expect(send).not.toHaveBeenCalled()
  await act(async () => button('Expand file20.ts').click())
  expect(send).toHaveBeenCalledTimes(1)
  expect(send).toHaveBeenCalledWith({ kind: 'recordedDiff', recordId: 'rec20', path: 'file20.ts', page: 0 })
  await act(async () => button('Collapse file20.ts').click())
  expect(host.textContent).not.toContain('return safe()')
  expect(host.querySelectorAll('[data-review-file]')).toHaveLength(21)
})

it('fetches bounded pages of long diffs and unmounts the previous lines', async () => {
  installMockClientUi()
  send.mockImplementation(async (op) => {
    if (op.kind !== 'recordedDiff') return undefined
    return { path: op.path, additions: 5000, deletions: 0, coverage: 'patch', page: op.page ?? 0, pageCount: 25, totalLines: 5000,
      hunks: [{ ...diff.hunks[0], lines: [{ kind: 'add', text: op.page ? 'page two' : 'page one', oldLine: null, newLine: op.page ? 201 : 1 }] }] }
  })
  render(agentSnapshot({ recorded: { ...agentSnapshot().recorded, files: [{ ...agentSnapshot().recorded.files[0], lineCount: 5000 }] } }))
  await flush()
  await act(async () => button('Expand src/a.ts').click())
  expect(host.textContent).toContain('page one')
  await act(async () => button('Next diff page').click())
  expect(send).toHaveBeenCalledWith({ kind: 'recordedDiff', recordId: 'rec', path: 'src/a.ts', page: 1 })
  expect(host.textContent).toContain('page two')
  expect(host.textContent).not.toContain('page one')
})

it('opens a revealed file and its terminal without reopening it on refresh', async () => {
  installMockClientUi()
  Element.prototype.scrollIntoView = vi.fn()
  const file = { ...agentSnapshot().recorded.files[0], commit: { hash: 'abc', message: 'Feature', date: '2026-11-14' } }
  const snapshot = agentSnapshot({ recorded: { ...agentSnapshot().recorded, files: [file] } })
  render(snapshot)
  await act(async () => button('Collapse Implement auth').click())
  expect(host.querySelector('[data-review-file]')).toBeNull()
  render({ ...snapshot, reveal: { seq: 1, path: 'src/a.ts' } })
  await flush()
  expect(button('Collapse src/a.ts')).not.toBeNull()
  expect(send).toHaveBeenCalledWith({ kind: 'recordedDiff', recordId: 'rec', path: 'src/a.ts', page: 0 })
  await act(async () => button('Collapse src/a.ts').click())
  send.mockClear()
  render({ ...snapshot, reveal: { seq: 1, path: 'src/a.ts' }, recorded: { ...snapshot.recorded, files: [{ ...file }] } })
  await flush()
  expect(button('Expand src/a.ts')).not.toBeNull()
  expect(send).not.toHaveBeenCalled()
})

it('collapses terminal groups independently without fetching their file diffs', async () => {
  installMockClientUi()
  const snapshot = agentSnapshot()
  const file = snapshot.recorded.files[0]
  render({ ...snapshot, recorded: { ...snapshot.recorded, files: [
    { ...file, commit: { hash: 'abc', message: 'Feature', date: '2026-11-14' } },
    { ...file, recordId: 'other', path: 'other.ts', panelIds: ['other'], panelTitles: { other: 'Other terminal' }, commit: { hash: 'def', message: 'Other commit', date: '2026-11-13' } },
  ] } })
  await flush()
  expect(send).not.toHaveBeenCalled()
  await act(async () => button('Collapse Implement auth').click())
  expect(button('Expand src/a.ts')).toBeNull()
  expect(button('Expand other.ts')).not.toBeNull()
  await act(async () => button('Expand Implement auth').click())
  expect(button('Expand src/a.ts')).not.toBeNull()
  expect(send).not.toHaveBeenCalled()
})

it('starts a review in the selected terminal and shows progress before the response', async () => {
  installMockClientUi()
  render(agentSnapshot())
  await act(async () => button('Review with…').click())
  expect(send).not.toHaveBeenCalledWith({ kind: 'reviewAgents' })
  send.mockImplementation((op) => op.kind === 'reviewWithAgent' ? new Promise(() => {}) : Promise.resolve(undefined))
  await act(async () => button('Review with Codex').click())
  expect(pickPanelPlace).toHaveBeenCalledWith({ workspaceId: 'ws', panelType: 'terminal', availability: 'both', sourcePanelId: 'review' })
  expect(send).toHaveBeenCalledWith({ kind: 'reviewWithAgent', agentId: 'codex', terminalPanelId: 't1' })
  expect(button('Review with…').disabled).toBe(true)
  expect(host.querySelector('[aria-label="Starting agent"]')).not.toBeNull()
})

it('reopens the review launch menu from shared availability without per-hover inspection', async () => {
  installMockClientUi()
  render(agentSnapshot())
  await flush()
  send.mockClear()
  act(() => button('Review with…').click())
  expect(button('Review with Codex')).not.toBeNull()
  act(() => button('Review with…').click())
  act(() => button('Review with…').click())
  expect(button('Review with Codex')).not.toBeNull()
  expect(send).not.toHaveBeenCalled()
  h.availability = { ...h.availability, types: [{ agentId: 'claude-code', ready: true }] }
  render(agentSnapshot())
  expect(button('Review with Codex')).toBeNull()
  expect(button('Review with Claude Code')).not.toBeNull()
})

it('renders the empty diff as a centered title and explanation', () => {
  installMockClientUi()
  const snapshot = agentSnapshot()
  render({ ...snapshot, review: { ...snapshot.review, agentChanges: { panelId: 't1' } }, recorded: { ...snapshot.recorded, files: [] } })
  const empty = host.querySelector('[data-review-empty]')!
  expect(empty.querySelector('[data-review-empty-content]')).not.toBeNull()
  expect(empty.textContent).toContain('No matching changes')
  expect(empty.textContent).toContain('Clear the review scope to see all recorded edits.')
})

it('uses the native display-options menu and collapses expanded files on selection', async () => {
  const ui = installMockClientUi({ showContextMenu: vi.fn().mockResolvedValue('collapse') })
  render(agentSnapshot())
  await act(async () => button('Expand src/a.ts').click())
  await act(async () => button('More review options').click())
  expect(ui.showContextMenu).toHaveBeenCalledWith(expect.arrayContaining([
    expect.objectContaining({ id: 'split', type: 'checkbox', checked: expect.any(Boolean) }),
    expect.objectContaining({ id: 'wordDiff', type: 'checkbox', checked: expect.any(Boolean) }),
    expect.objectContaining({ id: 'wrap', type: 'checkbox', checked: expect.any(Boolean) }),
    expect.objectContaining({ id: 'collapse', enabled: true }),
  ]))
  expect(button('Expand src/a.ts')).not.toBeNull()
  expect(document.querySelector('[role="menuitem"]')).toBeNull()
})

it('groups by terminal and opens the chosen file edit on demand', async () => {
  installMockClientUi()
  h.doc = { ...createDocument(), panels: { t1: { id: 't1', type: 'terminal', title: 'Implement auth', fields: {} } } }
  const snapshot = agentSnapshot()
  const file = snapshot.recorded.files[0]
  render({ ...snapshot, recorded: { ...snapshot.recorded, files: [file,
    { ...file, recordId: 'newest', createdAt: '2026-11-22T16:00:00Z', commit: { hash: 'abcdef1234', message: 'Implement login', date: '2026-11-22' }, prNumber: 42 },
    { ...file, recordId: 'closed', panelIds: ['closed'], panelTitles: { closed: 'Earlier session' } },
  ] } })
  const title = button('Go to Implement auth')
  expect(title.textContent).toBe('Implement auth')
  act(() => title.click())
  expect(revealPanel).toHaveBeenCalledWith('ws', 't1')
  expect([...host.querySelectorAll('[data-review-group-title]')].map((group) => group.textContent)).toEqual(['Implement auth', 'Earlier session'])
  expect(host.querySelectorAll('[data-review-file]')).toHaveLength(2)
  expect(host.querySelector('[data-review-file] [aria-label^="Go to"]')).toBeNull()
  await act(async () => button('Expand src/a.ts').click())
  expect(host.querySelectorAll('[data-review-edit]')).toHaveLength(2)
  expect(button('Expand edit 1 for src/a.ts').textContent).toContain('abcdef1 · Implement login')
  expect(button('Expand edit 1 for src/a.ts').textContent).toContain('PR #42')
  expect(send).not.toHaveBeenCalled()
  await act(async () => button('Expand edit 1 for src/a.ts').click())
  expect(send).toHaveBeenCalledWith({ kind: 'recordedDiff', recordId: 'newest', path: 'src/a.ts', page: 0 })
})

it('windows a large terminal and navigates or reveals an offscreen file', async () => {
  installMockClientUi()
  const snapshot = agentSnapshot()
  const files = Array.from({ length: 1000 }, (_, i) => ({ ...snapshot.recorded.files[0], recordId: `rec${i}`, path: `file${i}.ts` }))
  const large = { ...snapshot, recorded: { ...snapshot.recorded, files } }
  render(large)
  expect(host.querySelectorAll('[data-review-file]').length).toBeLessThan(40)
  expect(button('Expand file999.ts')).toBeNull()
  act(() => button('Collapse Implement auth').dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })))
  expect(document.activeElement).toBe(button('Expand file999.ts'))
  render({ ...large, reveal: { seq: 1, path: 'file500.ts' } })
  await flush()
  expect(button('Collapse file500.ts')).not.toBeNull()
  expect(send).toHaveBeenCalledWith({ kind: 'recordedDiff', recordId: 'rec500', path: 'file500.ts', page: 0 })
})

it('retains the selected diff page when Git attribution arrives', async () => {
  installMockClientUi()
  send.mockImplementation(async (op) => op.kind === 'recordedDiff' ? { path: op.path, hunks: diff.hunks, coverage: 'patch', page: op.page ?? 0, pageCount: 3, totalLines: 600 } : undefined)
  const snapshot = agentSnapshot()
  render(snapshot)
  await act(async () => button('Expand src/a.ts').click())
  await act(async () => button('Next diff page').click())
  expect(send).toHaveBeenLastCalledWith({ kind: 'recordedDiff', recordId: 'rec', path: 'src/a.ts', page: 1 })
  render({ ...snapshot, recorded: { ...snapshot.recorded, files: [{ ...snapshot.recorded.files[0], commit: { hash: 'new', message: 'Captured commit', date: '2026-11-14' } }] } })
  await flush()
  expect(send).toHaveBeenLastCalledWith({ kind: 'recordedDiff', recordId: 'rec', path: 'src/a.ts', page: 1 })
})
