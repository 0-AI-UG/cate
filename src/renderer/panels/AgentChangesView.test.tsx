import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  setWorktree: vi.fn(),
  workspace: { id: 'ws', rootPath: '/repo', worktrees: [] as any[], panels: {} as Record<string, any> }, records: [] as any[], loading: false, setState: vi.fn(), refresh: vi.fn(), reveal: vi.fn(),
}))
vi.mock('../stores/appStore', () => ({ useAppStore: Object.assign((selector: any) => selector({ workspaces: [h.workspace] }), {
  getState: () => ({ setPanelReviewState: h.setState, setPanelWorktreeId: h.setWorktree, getWorkspace: () => h.workspace }),
}) }))
vi.mock('../stores/useWorktrees', () => ({ useWorktrees: () => h.workspace.worktrees }))
vi.mock('../lib/useAgentChanges', () => ({ useAgentChanges: () => ({ records: h.records, loading: h.loading }), refreshAgentChanges: h.refresh }))
vi.mock('../lib/workspace/panelReveal', () => ({ revealPanel: h.reveal }))
import AgentChangesView from './AgentChangesView'
import { ReviewToolbar } from './ReviewToolbar'
import { recordedReviewPrompt } from './RecordedReviewButton'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
let host: HTMLDivElement
let root: ReturnType<typeof createRoot>
beforeEach(() => {
  vi.clearAllMocks()
  h.loading = false
  h.workspace.worktrees = []
  h.workspace.panels = {
    review: { reviewState: { repoPath: '/repo', spec: { kind: 'uncommitted' }, display: { split: false, wordDiff: true, wrap: false }, agentChanges: { panelId: 'a' } } },
    a: { id: 'a', type: 'terminal', title: 'Claude terminal' },
    b: { id: 'b', type: 'agent', title: 'Codex chat', agentThreadId: 'chat' },
  }
  h.records = ['a', 'b'].map((id) => ({
    id, source: id === 'a' ? 'terminal' : 't3', sourceId: id === 'a' ? 'pty' : 'chat', panelId: id,
    agentId: id === 'a' ? 'claude-code' : 'codex', sessionId: id, turnId: 'turn', mode: 'operation', createdAt: new Date().toISOString(),
    files: [{ path: `${id}.ts`, additions: 1, deletions: 1, coverage: 'fragment', hunks: [] }],
  }))
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove() })

it('shows only the source panel records and explains incomplete coverage', () => {
  act(() => root.render(<AgentChangesView workspaceId="ws" panelId="review" />))
  expect(host.textContent).toContain('a.ts')
  expect(host.textContent).not.toContain('b.ts')
  expect(host.querySelector('[title*="unreported edits may be missing"]')).not.toBeNull()
  expect(document.querySelector('[aria-label="Filter by agent"]')).toBeNull()
  expect(host.querySelector('[aria-label="Remove Claude terminal filter"]')).not.toBeNull()
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="Filters"]')!.click())
  expect(document.querySelector('[aria-label="Filter by agent"]')).not.toBeNull()
  const select = document.querySelector<HTMLSelectElement>('[aria-label="Filter by panel"]')!
  act(() => { select.value = 'b'; select.dispatchEvent(new Event('change', { bubbles: true })) })
  expect(h.setState).toHaveBeenLastCalledWith('ws', 'review', expect.objectContaining({ agentChanges: expect.objectContaining({ panelId: 'b' }) }))
})

it('offers every comparison mode and switches directly to staged changes', async () => {
  act(() => root.render(<AgentChangesView workspaceId="ws" panelId="review" />))
  const select = host.querySelector<HTMLSelectElement>('[aria-label="Comparison"]')!
  expect([...select.options].map((option) => option.value)).toEqual(['uncommitted', 'unstaged', 'staged', 'commit', 'branch', 'agent'])
  await act(async () => { select.value = 'staged'; select.dispatchEvent(new Event('change', { bubbles: true })) })
  expect(h.setState).toHaveBeenLastCalledWith('ws', 'review', expect.objectContaining({ spec: { kind: 'staged' }, agentChanges: undefined }))
})

it('switches diff worktrees and restores each checkout comparison and notes', async () => {
  window.electronAPI.showContextMenu = vi.fn().mockResolvedValueOnce('feature').mockResolvedValueOnce('main')
  h.workspace.worktrees = [
    { id: 'main', path: '/repo', branch: 'main', isPrimary: true },
    { id: 'feature', path: '/feature', branch: 'feature' },
  ]
  const original = { ...h.workspace.panels.review.reviewState, agentChanges: undefined, spec: { kind: 'branch', base: 'main', target: 'main' }, notes: [{ id: 'note', path: 'a.ts', body: 'Keep this note' }] }
  act(() => root.render(<ReviewToolbar state={original} workspaceId="ws" panelId="review" />))
  const select = host.querySelector<HTMLButtonElement>('[aria-label="Diff panel worktree"]')!
  await act(async () => select.click())
  const next = h.setState.mock.calls.at(-1)![2]
  expect(next).toMatchObject({ repoPath: '/feature', spec: { kind: 'branch', base: 'main', target: 'feature' } })
  expect(next.notes).toBeUndefined()
  expect(h.setWorktree).toHaveBeenLastCalledWith('ws', 'review', 'feature')
  act(() => root.render(<ReviewToolbar state={next} workspaceId="ws" panelId="review" />))
  await act(async () => select.click())
  expect(h.setState.mock.calls.at(-1)![2]).toMatchObject({ repoPath: '/repo', notes: original.notes, spec: original.spec })
})
it('offers Agent changes from the same repository comparison menu', async () => {
  const state = { ...h.workspace.panels.review.reviewState, agentChanges: undefined }
  act(() => root.render(<ReviewToolbar state={state} workspaceId="ws" panelId="review" />))
  const select = host.querySelector<HTMLSelectElement>('[aria-label="Comparison"]')!
  expect([...select.options].map((option) => option.value)).toEqual(['uncommitted', 'unstaged', 'staged', 'commit', 'branch', 'agent'])
  await act(async () => { select.value = 'agent'; select.dispatchEvent(new Event('change', { bubbles: true })) })
  expect(h.setState).toHaveBeenLastCalledWith('ws', 'review', expect.objectContaining({ agentChanges: expect.any(Object) }))
})

it('renders the agent logo and normal diff lines without patch metadata or session IDs', () => {
  h.records[0].sessionId = 'secret-session-id'
  h.records[0].files[0] = { path: 'a.ts', additions: 1, deletions: 0, coverage: 'patch', hunks: [
    { header: 'diff --git a/a.ts b/a.ts', lines: [{ kind: 'meta', text: 'new file mode 100644', oldLine: null, newLine: null }] },
    { header: '@@ -0,0 +1 @@', lines: [{ kind: 'add', text: 'hello', oldLine: null, newLine: 1 }] },
  ] }
  act(() => root.render(<AgentChangesView workspaceId="ws" panelId="review" />))
  expect(host.querySelector('img')?.alt).toContain('Claude')
  expect(host.textContent).toContain('hello')
  expect(host.textContent).not.toContain('secret-session-id')
  expect(host.textContent).not.toContain('new file mode')
  expect(host.textContent).not.toContain('@@')
  expect(host.querySelector('[aria-label^="Add review note"]')).toBeNull()
  act(() => host.querySelector<HTMLButtonElement>('section button')!.click())
  expect(host.textContent).not.toContain('hello')
})

it('removes scoped filters through chips and dismisses the popover', () => {
  h.workspace.panels.review.reviewState.agentChanges = { panelId: 'a', sessionId: 'session', turnId: 'turn' }
  act(() => root.render(<AgentChangesView workspaceId="ws" panelId="review" />))
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="Remove This turn filter"]')!.click())
  expect(h.setState).toHaveBeenLastCalledWith('ws', 'review', expect.objectContaining({ agentChanges: { panelId: 'a', sessionId: 'session', turnId: undefined } }))
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="Filters"]')!.click())
  expect(document.querySelector('[role="dialog"]')).not.toBeNull()
  act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
  expect(document.querySelector('[role="dialog"]')).toBeNull()
})

it('shows filtered totals and preserves filters when changing display options', async () => {
  act(() => root.render(<AgentChangesView workspaceId="ws" panelId="review" />))
  expect(host.textContent).toContain('1 files +1 -1')
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Refresh"]')!.click())
  expect(h.refresh).toHaveBeenCalledWith('/repo', 'ws')
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="Switch to split diff"]')!.click())
  expect(h.setState).toHaveBeenLastCalledWith('ws', 'review', expect.objectContaining({ agentChanges: { panelId: 'a' }, display: { split: true, wordDiff: true, wrap: false } }))
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="More review options"]')!.click())
  const wrap = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((button) => button.textContent?.includes('Wrap lines'))!
  act(() => wrap.click())
  expect(h.setState).toHaveBeenLastCalledWith('ws', 'review', expect.objectContaining({ display: { split: false, wordDiff: true, wrap: true } }))
})

it('reviews captured evidence without asking for the current checkout diff or exposing IDs', () => {
  const record = { ...h.records[0], sessionId: 'PRIVATE_SESSION', id: 'PRIVATE_ID', files: [{ path: 'a.ts', coverage: 'fragment', hunks: [{ lines: [{ kind: 'delete', text: 'before' }, { kind: 'add', text: 'after' }] }] }] }
  const prompt = recordedReviewPrompt([record])
  expect(prompt).toContain('historical reported edits')
  expect(prompt).toContain('a.ts (fragment)\n-before\n+after')
  expect(prompt).not.toContain('PRIVATE_')
  expect(prompt).not.toContain('b.ts')
})

it.each(['terminal', 't3'])('shows the current Cate title and reveals the %s source without collapsing the diff', async (source) => {
  h.workspace.panels.review.reviewState.agentChanges = {}
  h.records = [h.records[source === 'terminal' ? 0 : 1]]
  const id = source === 'terminal' ? 'a' : 'b'
  h.workspace.panels[id].title = 'My renamed panel'
  await act(async () => root.render(<AgentChangesView workspaceId="ws" panelId="review" />))
  const chip = host.querySelector<HTMLButtonElement>('[aria-label="Go to My renamed panel"]')!
  expect(chip.textContent).toBe('My renamed panel')
  expect(chip.parentElement?.closest('button')).toBeNull()
  await act(async () => chip.click())
  expect(h.reveal).toHaveBeenCalledWith('ws', id)
  expect(host.querySelector('section button[aria-expanded]')?.getAttribute('aria-expanded')).toBe('true')
})

it('keeps closed source panels non-clickable and does not display their IDs', () => {
  h.records[0].panelId = 'closed-private-id'
  h.workspace.panels.review.reviewState.agentChanges = {}
  h.records = [h.records[0]]
  act(() => root.render(<AgentChangesView workspaceId="ws" panelId="review" />))
  expect(host.textContent).toContain('Panel closed')
  expect(host.textContent).not.toContain('closed-private-id')
  expect(host.querySelector('section [aria-label^="Go to"]')).toBeNull()
})

it('intersects the agent and panel filters, without falling back to Git', () => {
  h.workspace.panels.review.reviewState.agentChanges = { panelId: 'a', agentId: 'codex' }
  act(() => root.render(<AgentChangesView workspaceId="ws" panelId="review" />))
  expect(host.textContent).toContain('No recorded edits match')
  expect(host.textContent).not.toContain('a.ts')
  expect(host.textContent).not.toContain('b.ts')
})

it('waits for a restored workspace and recovers without a panel reload', () => {
  h.workspace.id = 'not-restored-yet'
  act(() => root.render(<AgentChangesView workspaceId="ws" panelId="review" />))
  expect(host.querySelector('[role="status"]')?.textContent).toBe('Loading review panel…')
  expect(host.querySelector('[role="status"] .animate-spin')).not.toBeNull()
  expect(host.querySelector('[aria-label="Comparison"]')).toBeNull()
  h.workspace.id = 'ws'
  act(() => root.render(<AgentChangesView workspaceId="ws" panelId="review" />))
  expect(host.textContent).toContain('a.ts')
  expect(host.querySelector<HTMLSelectElement>('[aria-label="Comparison"]')?.value).toBe('agent')
  h.workspace.id = 'removed'
  act(() => root.render(<AgentChangesView workspaceId="ws" panelId="review" />))
  expect(host.querySelector('[role="status"]')).not.toBeNull()
  h.workspace.id = 'ws'
})

it('renders the source chip with the same worktree title color and panel icon as tabs', () => {
  h.workspace.worktrees = [{ id: 'primary', path: '/repo', color: '#11aa22' }, { id: 'feature', path: '/feature', color: '#aa22bb' }]
  h.workspace.panels.a.worktreeId = 'feature'
  act(() => root.render(<AgentChangesView workspaceId="ws" panelId="review" />))
  const chip = host.querySelector<HTMLButtonElement>('[aria-label="Go to Claude terminal"]')!
  expect(chip.querySelector('svg')).not.toBeNull()
  expect(chip.querySelector<HTMLElement>('span.truncate')?.style.color).toBe('rgb(170, 34, 187)')
})

it('uses the shared loading indicator while recorded changes are loading', () => {
  h.loading = true
  act(() => root.render(<AgentChangesView workspaceId="ws" panelId="review" />))
  expect(host.querySelector('[aria-busy="true"] .animate-spin')).not.toBeNull()
  expect(host.querySelector('[aria-label="Refreshing changes"] .animate-spin')).not.toBeNull()
  expect(host.textContent).not.toContain('No recorded edits match')
})

it('waits for the panel and review state to restore in separate updates', () => {
  const panel = h.workspace.panels.review
  delete h.workspace.panels.review
  act(() => root.render(<AgentChangesView workspaceId="ws" panelId="review" />))
  expect(host.querySelector('[role="status"]')).not.toBeNull()
  h.workspace.panels.review = {}
  act(() => root.render(<AgentChangesView workspaceId="ws" panelId="review" />))
  expect(host.querySelector('[role="status"]')).not.toBeNull()
  h.workspace.panels.review = panel
  act(() => root.render(<AgentChangesView workspaceId="ws" panelId="review" />))
  expect(host.textContent).toContain('a.ts')
  expect(h.setState).not.toHaveBeenCalled()
})

it('expands a collapsed recorded file when a deep link targets it again', () => {
  act(() => root.render(<AgentChangesView workspaceId="ws" panelId="review" />))
  act(() => host.querySelector<HTMLButtonElement>('section button')!.click())
  expect(host.querySelector('section button')?.getAttribute('aria-expanded')).toBe('false')
  h.workspace.panels.review.reviewState = { ...h.workspace.panels.review.reviewState, focusedFile: 'a.ts', agentChanges: { panelId: 'a' } }
  act(() => root.render(<AgentChangesView workspaceId="ws" panelId="review" />))
  expect(host.querySelector('section button')?.getAttribute('aria-expanded')).toBe('true')
})

it('pages long histories while allowing a deep link beyond the first page', () => {
  h.records = Array.from({ length: 75 }, (_, index) => ({ ...h.records[0], id: `record-${index}`, files: [{ ...h.records[0].files[0], path: `${index}.ts` }] }))
  act(() => root.render(<AgentChangesView workspaceId="ws" panelId="review" />))
  expect(host.querySelectorAll('section')).toHaveLength(50)
  h.workspace.panels.review.reviewState = { ...h.workspace.panels.review.reviewState, focusedFile: '70.ts', agentChanges: { panelId: 'a' } }
  act(() => root.render(<AgentChangesView workspaceId="ws" panelId="review" />))
  expect(host.querySelector('[data-review-file="70.ts"]')).not.toBeNull()
})

it('waits until a recorded diff approaches the viewport before rendering its lines', () => {
  let intersect!: IntersectionObserverCallback
  const disconnect = vi.fn()
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: IntersectionObserverCallback) { intersect = callback }
    observe() {}
    disconnect = disconnect
  })
  try {
    h.records[0].files[0].hunks = [{ lines: [{ kind: 'add', text: 'deferred-line', newLine: 1, oldLine: null }] }]
    act(() => root.render(<AgentChangesView workspaceId="ws" panelId="review" />))
    expect(host.textContent).not.toContain('deferred-line')
    act(() => intersect([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver))
    expect(host.textContent).toContain('deferred-line')
    expect(disconnect).toHaveBeenCalled()
  } finally { vi.unstubAllGlobals() }
})

it('requires an explicit load before rendering a very large recorded diff', () => {
  h.records[0].files[0].hunks = [{ lines: Array.from({ length: 5001 }, () => ({ kind: 'add', text: 'large-line', newLine: null, oldLine: null })) }]
  act(() => root.render(<AgentChangesView workspaceId="ws" panelId="review" />))
  expect(host.textContent).not.toContain('large-line')
  expect([...host.querySelectorAll('button')].some((button) => button.textContent === 'Load large recorded diff')).toBe(true)
})
