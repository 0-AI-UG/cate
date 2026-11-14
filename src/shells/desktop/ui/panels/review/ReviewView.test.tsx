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
vi.mock('@client/host', async (importOriginal) => ({ ...(await importOriginal<typeof import('@client/host')>()), pickPanelPlace }))

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
    review: { repoPath: '/repo', agentChanges: { agentId: 'codex' } },
    recorded: { loading: false, error: null, panels: [{ id: 't1', title: 'Implement auth', agentIds: ['codex'] }], agents: [{ agentId: 'codex', edits: 1, uncommittedEdits: 1 }], files: [{ recordId: 'rec', agentId: 'codex', panelIds: ['t1'], path: 'src/a.ts', additions: 1, deletions: 0, coverage: 'patch', lineCount: 1 }] },
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
  expect(button('Filter by agent')).not.toBeNull()
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
  render(agentSnapshot({ recorded: { loading: true, error: null, files: [], panels: [], agents: [] } }))
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

it('uses the agent logo flyout and immediately shows loading while a selection is pending', async () => {
  installMockClientUi()
  render(agentSnapshot({ recorded: { ...agentSnapshot().recorded, agents: [{ agentId: 'codex', edits: 1, uncommittedEdits: 1 }, { agentId: 'claude-code', edits: 2, uncommittedEdits: 2 }] } }))
  await flush()
  send.mockImplementation((op) => op.kind === 'updateFilter' ? new Promise(() => {}) : Promise.resolve(undefined))
  act(() => button('Filter by agent').click())
  expect(document.querySelector('[role="menu"][aria-label="Filter agent changes"]')).not.toBeNull()
  act(() => button('Filter by Claude Code').click())
  expect(send).toHaveBeenCalledWith({ kind: 'updateFilter', patch: { agentId: 'claude-code', panelId: null, sessionId: null, turnId: null } })
  expect(host.textContent).toContain('Loading agent changes')
  expect(button('Filter by agent').disabled).toBe(true)
  expect(host.querySelector('[data-review-file]')).toBeNull()
})

it('selects open panels only through the spatial picker', async () => {
  installMockClientUi()
  h.doc = { ...createDocument(), panels: { t1: { id: 't1', type: 'terminal', title: 'Implement auth', fields: {} } } }
  render(agentSnapshot())
  await flush()
  await act(async () => button('Select source panel on canvas').click())
  expect(pickPanelPlace).toHaveBeenCalledWith({ workspaceId: 'ws', panelType: 'terminal', availability: 'existing', sourcePanelId: 'review' })
  expect(send).toHaveBeenCalledWith({ kind: 'updateFilter', patch: { panelId: 't1', sessionId: null, turnId: null } })
})

it('lists closed sources by their recorded titles even when a different source is filtered', async () => {
  installMockClientUi()
  render(agentSnapshot({
    review: { ...agentSnapshot().review, agentChanges: { panelId: 'other', agentId: 'codex' } },
    recorded: { loading: false, error: null, files: [], agents: [{ agentId: 'codex', edits: 1, uncommittedEdits: 0 }], panels: [{ id: 'closed', title: 'Fix checkout races', agentIds: ['codex'] }] },
  }))
  act(() => button('Source panel history').click())
  expect(document.querySelector('[role="menu"][aria-label="Closed source panels"]')?.textContent).toContain('Closed')
  expect(document.querySelectorAll('[role="menu"][aria-label="Closed source panels"] [role="menuitem"]')).toHaveLength(2)
  await act(async () => button('Fix checkout races').click())
  expect(send).toHaveBeenCalledWith({ kind: 'updateFilter', patch: { panelId: 'closed', sessionId: null, turnId: null } })
  expect(host.textContent).not.toContain('Closed panel 1')
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

it('opens a revealed file and its commit without reopening it on refresh', async () => {
  installMockClientUi()
  Element.prototype.scrollIntoView = vi.fn()
  const file = { ...agentSnapshot().recorded.files[0], commit: { hash: 'abc', message: 'Feature', date: '2026-11-14' } }
  const snapshot = agentSnapshot({ recorded: { ...agentSnapshot().recorded, files: [file] } })
  render(snapshot)
  await act(async () => button('Collapse commit Feature').click())
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

it('collapses commit groups independently without fetching their file diffs', async () => {
  installMockClientUi()
  const snapshot = agentSnapshot()
  const file = snapshot.recorded.files[0]
  render({ ...snapshot, recorded: { ...snapshot.recorded, files: [
    { ...file, commit: { hash: 'abc', message: 'Feature', date: '2026-11-14' } },
    { ...file, recordId: 'other', path: 'other.ts', commit: { hash: 'def', message: 'Other commit', date: '2026-11-13' } },
  ] } })
  await flush()
  expect(send).not.toHaveBeenCalled()
  await act(async () => button('Collapse commit Feature').click())
  expect(button('Expand src/a.ts')).toBeNull()
  expect(button('Expand other.ts')).not.toBeNull()
  await act(async () => button('Expand commit Feature').click())
  expect(button('Expand src/a.ts')).not.toBeNull()
  expect(send).not.toHaveBeenCalled()
})

it('starts a review in the selected terminal and shows progress before the response', async () => {
  installMockClientUi()
  render(agentSnapshot())
  await act(async () => button('Review in terminal').click())
  expect(send).not.toHaveBeenCalledWith({ kind: 'reviewAgents' })
  send.mockImplementation((op) => op.kind === 'reviewWithAgent' ? new Promise(() => {}) : Promise.resolve(undefined))
  await act(async () => button('Review with Codex').click())
  expect(pickPanelPlace).toHaveBeenCalledWith({ workspaceId: 'ws', panelType: 'terminal', availability: 'both', sourcePanelId: 'review' })
  expect(send).toHaveBeenCalledWith({ kind: 'reviewWithAgent', agentId: 'codex', terminalPanelId: 't1' })
  expect(button('Review in terminal').disabled).toBe(true)
  expect(host.querySelector('[aria-label="Starting agent"]')).not.toBeNull()
})

it('keeps agent and panel selection in the action bar and search collapsed by default', async () => {
  installMockClientUi()
  render(agentSnapshot())
  await flush()
  expect(button('Filter by agent').closest('[role="toolbar"]')).toBe(button('Source panel history').closest('[role="toolbar"]'))
  expect(button('Filter by agent').title).toContain('Codex')
  expect(host.querySelector('input[aria-label="Filter changed files"]')).toBeNull()
  act(() => button('Filter changed files').click())
  expect(host.querySelector('input[aria-label="Filter changed files"]')).not.toBeNull()
})

it('omits agents without recorded contributions from the filter menu', async () => {
  installMockClientUi()
  render(agentSnapshot())
  await flush()
  send.mockClear()
  act(() => button('Filter by agent').click())
  expect(button('Filter by Grok')).toBeNull()
  expect(button('Filter by Codex').disabled).toBe(false)
  expect(send).not.toHaveBeenCalled()
})

it('disables source selection when open panels have not contributed any recorded changes', () => {
  installMockClientUi()
  h.doc = { ...createDocument(), panels: { t1: { id: 't1', type: 'terminal', title: 'Shell', fields: {} } } }
  render(agentSnapshot({ recorded: { loading: false, error: null, files: [], panels: [], agents: [] } }))
  expect(button('Source panel history').disabled).toBe(true)
  expect(button('Filter by agent').disabled).toBe(true)
})

it('reopens the review launch menu from shared availability without per-hover inspection', async () => {
  installMockClientUi()
  render(agentSnapshot())
  await flush()
  send.mockClear()
  act(() => button('Review in terminal').click())
  expect(button('Review with Codex')).not.toBeNull()
  act(() => button('Review in terminal').click())
  act(() => button('Review in terminal').click())
  expect(button('Review with Codex')).not.toBeNull()
  expect(send).not.toHaveBeenCalled()
  h.availability = { ...h.availability, types: [{ agentId: 'claude-code', ready: true }] }
  render(agentSnapshot())
  expect(button('Review with Codex')).toBeNull()
  expect(button('Review with Claude Code')).not.toBeNull()
})

it('renders the empty diff as a centered title and explanation', () => {
  installMockClientUi()
  render(agentSnapshot({ review: { ...agentSnapshot().review,  }, recorded: { loading: false, error: null, files: [], panels: [], agents: [{ agentId: 'codex', edits: 2, uncommittedEdits: 0 }] } }))
  const empty = host.querySelector('[data-review-empty]')!
  expect(empty.querySelector('[data-review-empty-content]')).not.toBeNull()
  expect(empty.textContent).toContain('No matching changes')
  expect(empty.textContent).toContain('Try another source panel')
})

it('keeps spatial selection directly available beside closed source history', async () => {
  installMockClientUi()
  h.doc = { ...createDocument(), panels: { t1: { id: 't1', type: 'terminal', title: 'Implement auth', fields: {} } } }
  const snapshot = agentSnapshot()
  render({ ...snapshot, recorded: { ...snapshot.recorded, panels: [...snapshot.recorded.panels, { id: 'closed', title: 'Fix checkout races', agentIds: ['codex'] }] } })
  await flush()
  act(() => button('Source panel history').click())
  const spatial = button('Select source panel on canvas')
  expect(document.querySelector('[role="menuitem"][aria-label="Implement auth"]')).toBeNull()
  expect(button('Fix checkout races')).not.toBeNull()
  expect(document.querySelectorAll('[role="menu"][aria-label="Closed source panels"] [role="menuitem"]')).toHaveLength(2)
  await act(async () => spatial.click())
  expect(document.querySelector('[role="menu"][aria-label="Closed source panels"]')).toBeNull()
  expect(pickPanelPlace).toHaveBeenCalledWith({ workspaceId: 'ws', panelType: 'terminal', availability: 'existing', sourcePanelId: 'review' })
  expect(send).toHaveBeenCalledWith({ kind: 'updateFilter', patch: { panelId: 't1', sessionId: null, turnId: null } })
})

it('groups edits by commit with no active or history toggle', async () => {
  installMockClientUi()
  const snapshot = agentSnapshot()
  const file = snapshot.recorded.files[0]
  render({ ...snapshot, recorded: { ...snapshot.recorded, files: [
    { ...file, uncommitted: true },
    { ...file, recordId: 'committed', commit: { hash: 'abc123456', message: 'Implement login', date: '2026-11-13' } },
    { ...file, recordId: 'same-commit', commit: { hash: 'abc123456', message: 'Implement login', date: '2026-11-13' } },
  ] } })
  await flush()
  expect([...host.querySelectorAll('[data-review-group-title]')].map((group) => group.textContent)).toEqual(['Uncommitted changes', 'Implement login'])
  expect(document.querySelector('button[aria-label="Show active changes"]')).toBeNull()
  expect(document.querySelector('button[aria-label="Show recorded history"]')).toBeNull()
})

it('groups captured PR context with commits underneath and keeps unknown associations explicit', async () => {
  installMockClientUi()
  const snapshot = agentSnapshot()
  const file = snapshot.recorded.files[0]
  render({ ...snapshot, recorded: { ...snapshot.recorded, files: [
    { ...file, recordId: 'known', prNumber: 42, commit: { hash: 'abc', message: 'Implement login', date: '2026-11-14' } },
    { ...file, recordId: 'unknown', path: 'other.ts' },
  ] } })
  const select = host.querySelector<HTMLSelectElement>('[aria-label="Group recorded edits"]')!
  await act(async () => { select.value = 'pullRequest'; select.dispatchEvent(new Event('change', { bubbles: true })) })
  expect(host.textContent).toContain('Recorded for PR #42')
  expect(host.textContent).toContain('Implement login')
  expect(host.textContent).toContain('No recorded pull request')
  expect(send).not.toHaveBeenCalled()
})

it('centers the agent flyout beneath its trigger', async () => {
  installMockClientUi()
  const measure = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return this.querySelector('button[aria-label="Filter by agent"]') ? new DOMRect(100, 100, 30, 28) : new DOMRect(0, 0, 46, 46)
  })
  try {
    render(agentSnapshot())
    await act(async () => button('Filter by agent').click())
    const flyout = document.querySelector<HTMLElement>('[role="menu"][aria-label="Filter agent changes"]')!
    expect(flyout.parentElement!.style.left).toBe('92px')
  } finally { measure.mockRestore() }
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

it('omits repeated file source labels while a source panel is selected', async () => {
  installMockClientUi()
  h.doc = { ...createDocument(), panels: { t1: { id: 't1', type: 'terminal', title: 'Implement auth', fields: {} } } }
  const snapshot = agentSnapshot()
  render({ ...snapshot, recorded: { ...snapshot.recorded, files: [{ ...snapshot.recorded.files[0], panelIds: ['t1', 'closed'], panelTitles: { closed: 'Earlier session' } }] } })
  expect(button('Go to Implement auth')).not.toBeNull()
  render({ ...snapshot, review: { ...snapshot.review, agentChanges: { agentId: 'codex', panelId: 't1' } } })
  expect(host.querySelector('[data-review-file] [aria-label^="Go to"]')).toBeNull()
  expect(host.querySelector('[data-review-file] [title="Source panel closed"]')).toBeNull()
  expect(button('Clear source panel filter')).not.toBeNull()
})

it('allows selecting a terminal that has no matching recorded edits', async () => {
  installMockClientUi()
  h.doc = { ...createDocument(), panels: { other: { id: 'other', type: 'terminal', title: 'Update README', fields: {} } } }
  pickPanelPlace.mockResolvedValueOnce({ kind: 'existing', panelId: 'other' })
  const snapshot = agentSnapshot({ recorded: { loading: false, error: null, files: [], panels: [], agents: [] } })
  render(snapshot)
  expect(button('Select source panel on canvas').disabled).toBe(false)
  await act(async () => button('Select source panel on canvas').click())
  expect(pickPanelPlace).toHaveBeenCalledWith({ workspaceId: 'ws', panelType: 'terminal', availability: 'existing', sourcePanelId: 'review' })
  expect(send).toHaveBeenCalledWith({ kind: 'updateFilter', patch: { panelId: 'other', sessionId: null, turnId: null } })
  render({ ...snapshot, review: { ...snapshot.review, agentChanges: { panelId: 'other' } } })
  expect(button('Clear source panel filter').textContent).toContain('Update README')
  expect(host.querySelectorAll('[data-review-file]')).toHaveLength(0)
})

it('retains the selected diff page when background attribution moves a file into a commit group', async () => {
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
