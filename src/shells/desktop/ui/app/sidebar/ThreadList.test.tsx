import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { createMemoryDeviceStore } from '@kernel/state/contract'
import type { PanelAgentState } from '@services/agents/contract'
import type { TerminalStatus } from '@services/terminal/contract'
import type { PanelRecord } from '@workspace/document/contract'
import { createUiStateStore, installUiState, uiState } from '../state/uiState'
import { ThreadList, threadActivityText } from './ThreadList'
import { revealPanel } from '../navigation'

const data = vi.hoisted(() => ({
  panels: {} as Record<string, PanelRecord>, agents: {} as Record<string, PanelAgentState>, terminals: {} as Record<string, TerminalStatus>, connected: true,
}))
vi.mock('../../client/document', () => ({ useClientState: () => null, useDocument: (_id: string, select: (d: unknown) => unknown) => select({ panels: data.panels }) }))
vi.mock('../../client/connections', () => ({ useConnectionState: () => ({ kind: data.connected ? 'connected' : 'offline' }) }))
vi.mock('../../services/agents', () => ({ useAgentPanels: (_id: string, select: (s: unknown) => unknown) => select(data.agents), AgentMark: () => null }))
vi.mock('@services/agents/client', async (original) => ({ ...await original<object>(), watchAgentChat: () => ({ get: () => null, subscribe: () => () => {}, release: () => {} }) }))
vi.mock('../state/statusStore', () => ({ useTerminalStatuses: () => data.terminals }))
vi.mock('../app', () => ({ clientApp: () => ({ connections: { get: () => undefined } }) }))
vi.mock('../navigation', () => ({ revealPanel: vi.fn(async () => true), selectWorkspace: vi.fn(async () => true) }))

let host: HTMLDivElement
let root: Root
const entries = [{ id: 'ws', kind: 'local' as const, name: 'Cate', root: '/cate', lastOpenedAt: 1 }]
const render = (hidden = false) => act(() => root.render(<ThreadList entries={entries} open={['ws']} hidden={hidden} />))
const panel = (id: string) => { data.panels[id] = { id, type: 'terminal', title: id, fields: {} } }
const agent = (id: string, status: PanelAgentState['status'], canReceivePrompt = false) => {
  panel(id)
  data.agents = { ...data.agents, [id]: { panelId: id, agentId: 'codex', agentName: 'Codex', label: 'Codex', status, canReceivePrompt, present: status !== 'finished', session: null, contextPolicy: null } }
}
const terminal = (id: string, running: boolean) => {
  panel(id)
  data.terminals = { ...data.terminals, [id]: { id, panelId: id, activity: running ? { type: 'running', processName: 'npm test' } : { type: 'idle' }, alive: true, exitCode: null, cwd: '/cate', pid: 1, shell: 'zsh', ports: [], suspended: false, viewers: 1 } }
}
const button = (text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(text))!

beforeEach(async () => {
  data.panels = {}; data.agents = {}; data.terminals = {}; data.connected = true
  const ui = createUiStateStore(createMemoryDeviceStore())
  await ui.load(); installUiState(ui)
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove(); installUiState(null) })

it('keeps snooze separate from settle, persists its deadline and returns the thread when due', () => {
  vi.useFakeTimers()
  try {
    vi.setSystemTime(new Date(2026, 10, 8, 15, 0))
    agent('Review changes', 'waitingForInput', true)
    render()
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="Snooze Review changes"]')!.click())
    const menu = document.querySelector('[role="dialog"][aria-label="Snooze thread"]')!
    expect(menu).not.toBeNull()
    const hour = [...menu.querySelectorAll('button')].find((entry) => entry.textContent?.includes('In 1 hour'))!
    act(() => hour.click())
    expect(Object.values(uiState()!.getSnapshot().sidebarThreadSnoozes)).toEqual([Date.now() + 3_600_000])
    expect(host.querySelector('[aria-label="Ready for review"]')).toBeNull()
    expect(host.querySelector('[aria-label="Snoozed threads"]')?.textContent).toContain('1')
    expect(host.querySelector('#sidebar-settled-threads')?.textContent).not.toContain('Review changes')
    act(() => root.unmount())
    root = createRoot(host)
    render()
    expect(host.querySelector('[aria-label="Ready for review"]')).toBeNull()
    act(() => vi.advanceTimersByTime(3_600_001))
    expect(host.querySelector('[aria-label="Ready for review"]')?.textContent).toContain('Review changes')
    expect(uiState()!.getSnapshot().sidebarThreadSnoozes).toEqual({})
  } finally { vi.useRealTimers() }
})

it.each(['waitingForInput', 'finished'] as const)('un-settles a %s thread back into ready for review', (status) => {
  agent('Review changes', status, status === 'waitingForInput')
  render()
  if (status === 'waitingForInput') act(() => host.querySelector<HTMLButtonElement>('[aria-label="Mark Review changes settled"]')!.click())
  act(() => button('Settled').click())
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="Un-settle Review changes"]')!.click())
  expect(host.querySelector('[aria-label="Ready for review"]')?.textContent).toContain('Review changes')
  expect(host.querySelector('#sidebar-settled-threads')?.textContent).not.toContain('Review changes')
})

it('shows the same project, device and agent details for a settled thread', () => {
  vi.useFakeTimers()
  try {
    agent('Finished review', 'finished')
    render()
    act(() => button('Settled').click())
    const row = host.querySelector('#sidebar-settled-threads [data-thread-phase]')!
    act(() => row.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
    act(() => vi.advanceTimersByTime(250))
    const tooltip = document.querySelector('[role="tooltip"]')!
    expect(tooltip.textContent).toContain('Finished review')
    expect(tooltip.textContent).toContain('Cate')
    expect(tooltip.textContent).toContain('This device')
    expect(tooltip.textContent).toContain('Codex')
  } finally { vi.useRealTimers() }
})

it('shows elapsed time since manual settlement and updates it while the list is open', () => {
  vi.useFakeTimers()
  try {
    vi.setSystemTime(new Date(2026, 10, 8, 17, 0))
    agent('Review changes', 'waitingForInput', true)
    render()
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="Mark Review changes settled"]')!.click())
    act(() => button('Settled').click())
    const age = () => host.querySelector('#sidebar-settled-threads [title^="Settled "]')!
    expect(age().textContent).toBe('now')
    act(() => vi.advanceTimersByTime(60_000))
    expect(age().textContent).toBe('1m')
    act(() => vi.advanceTimersByTime(59 * 60_000))
    expect(age().textContent).toBe('1h')
  } finally { vi.useRealTimers() }
})

it('uses the observed completion time when a running agent exits', () => {
  vi.useFakeTimers()
  try {
    agent('Finished review', 'running')
    render()
    act(() => vi.advanceTimersByTime(120_000))
    agent('Finished review', 'finished')
    render()
    act(() => button('Settled').click())
    const age = () => host.querySelector('#sidebar-settled-threads [title^="Completed "]')!
    expect(age().textContent).toBe('now')
    act(() => vi.advanceTimersByTime(120_000))
    expect(age().textContent).toBe('2m')
  } finally { vi.useRealTimers() }
})

it('prioritizes blocking questions over ready prompts and working agents', () => {
  agent('ready', 'waitingForInput', true); agent('question', 'waitingForInput'); agent('working', 'running')
  render()
  const attention = host.querySelector('[aria-label="Needs attention"]')!
  expect([...attention.querySelectorAll('[data-thread-phase]')].map((el) => el.getAttribute('data-thread-phase'))).toEqual(['blocked'])
  expect(host.querySelector('[aria-label="Ready for review"] [data-thread-phase="ready"]')).not.toBeNull()
  expect(attention.textContent).toContain('Needs your response')
  expect(host.querySelector('[aria-label="In progress"]')?.textContent).toContain('Working')
  act(() => button('question').click())
  expect(revealPanel).toHaveBeenCalledWith('ws', 'question')
})

it('shows thread details on hover and keeps the settle action separate from navigation', () => {
  vi.useFakeTimers()
  try {
    agent('Review the changes', 'waitingForInput', true)
    render()
    const row = host.querySelector('[data-thread-phase="ready"]')!
    act(() => { row.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
    act(() => { vi.advanceTimersByTime(250) })
    const tooltip = document.querySelector('[role="tooltip"]')!
    expect(tooltip.textContent).toContain('Review the changes')
    expect(tooltip.textContent).toContain('Cate')
    expect(tooltip.textContent).toContain('This device')
    expect(tooltip.textContent).toContain('Codex')
    act(() => { host.querySelector<HTMLButtonElement>('[aria-label="Mark Review the changes settled"]')!.click() })
    expect(host.querySelector('#sidebar-settled-threads')?.textContent).toContain('Review the changes')
  } finally {
    vi.useRealTimers()
  }
})

it('settles ready work, retains it in the bottom dropdown, and resurfaces a new turn', () => {
  agent('ready', 'waitingForInput', true); render()
  act(() => (host.querySelector('[aria-label="Mark ready settled"]') as HTMLButtonElement).click())
  expect(host.querySelector('[aria-label="Needs attention"]')).toBeNull()
  expect(button('Settled').textContent).toContain('1')
  expect(host.querySelector('#sidebar-settled-threads')?.hasAttribute('hidden')).toBe(true)
  act(() => button('Settled').click())
  expect(host.querySelector('#sidebar-settled-threads')?.hasAttribute('hidden')).toBe(false)
  agent('ready', 'running'); render(true)
  agent('ready', 'waitingForInput', true); render()
  expect(host.querySelector('[aria-label="Ready for review"]')?.textContent).toContain('ready')
})

it('surfaces shell command completion without treating an initially idle shell as a question', () => {
  terminal('shell', false); render()
  expect(host.querySelector('[aria-label="Needs attention"]')).toBeNull()
  terminal('shell', true); render(true)
  terminal('shell', false); render()
  expect(host.querySelector('[aria-label="Ready for review"]')?.textContent).toContain('Command finished')
})

it('keeps exited agents in Settled and removes stale rows when disconnected or closed', () => {
  agent('done', 'finished'); render()
  expect(button('Settled').textContent).toContain('1')
  data.connected = false; render()
  expect(button('Settled').textContent).toContain('0')
  data.connected = true; render()
  data.panels = {}; render()
  expect(button('Settled').textContent).toContain('0')
})


it('clears settled acknowledgement after a disconnect so new results can resurface', () => {
  agent('ready', 'waitingForInput', true); render()
  act(() => (host.querySelector('[aria-label="Mark ready settled"]') as HTMLButtonElement).click())
  data.connected = false; render()
  data.connected = true; render()
  expect(host.querySelector('[aria-label="Ready for review"]')?.textContent).toContain('ready')
})

it('aggregates open workspaces and removes a workspace when it closes', () => {
  agent('question', 'waitingForInput')
  const other = { ...entries[0], id: 'other', name: 'Website' }
  act(() => root.render(<ThreadList entries={[...entries, other]} open={['ws', 'other']} hidden={false} />))
  expect(host.querySelector('[aria-label="Needs attention"]')?.textContent).toContain('Website')
  expect(host.querySelectorAll('[data-thread-phase="blocked"]')).toHaveLength(2)
  act(() => root.render(<ThreadList entries={[...entries, other]} open={['ws']} hidden={false} />))
  expect(host.querySelectorAll('[data-thread-phase="blocked"]')).toHaveLength(1)
  expect(host.querySelector('[aria-label="Needs attention"]')?.textContent).not.toContain('Website')
})


it('explains missing hooks instead of claiming the agent is working', () => {
  agent('untracked', 'notRunning')
  data.agents.untracked.hooksMissing = true
  render()
  expect(host.textContent).toContain('Hooks off')
  expect(host.querySelector('[aria-label="Enable status for untracked"]')).not.toBeNull()
  expect(host.querySelector('[data-thread-phase="running"]')).toBeNull()
})


it('shows reported activity separately from the thread name and never substitutes the prompt', () => {
  const chat = { status: 'running' as const, canReceivePrompt: false, stepsSince: '2026-11-07T20:00:00Z', prompts: [],
    messages: [{ role: 'user' as const, text: 'explain this', createdAt: '2026-11-07T20:00:00Z' }], steps: [] }
  expect(threadActivityText(chat)).toBeNull()
  expect(threadActivityText({ ...chat, steps: [{ tool: 'Read', subject: 'README.md', at: '2026-11-07T20:00:02Z' }] })).toBe('Read: README.md')
  expect(threadActivityText({ ...chat, messages: [...chat.messages, { role: 'assistant', text: 'Checking the project structure.', createdAt: '2026-11-07T20:00:03Z' }] })).toBe('Checking the project structure.')
  expect(threadActivityText({ ...chat, steps: [{ tool: 'Read', subject: 'old.ts', at: '2026-11-07T19:00:00Z' }] })).toBeNull()
})

it('combines search and project filters across active and settled threads', () => {
  agent('Fix sidebar', 'waitingForInput', true)
  agent('Finished task', 'finished')
  const other = { ...entries[0], id: 'other', name: 'Website' }
  act(() => root.render(<ThreadList entries={[...entries, other]} open={['ws', 'other']} hidden={false} query="sidebar" projectId="other" />))
  expect(host.querySelectorAll('[data-thread-phase]')).toHaveLength(1)
  expect(host.querySelector('[data-thread-phase]')?.textContent).toContain('Website')
  act(() => root.render(<ThreadList entries={[...entries, other]} open={['ws', 'other']} hidden={false} query="finished" projectId="ws" />))
  expect(button('Settled').textContent).toContain('1')
  expect(host.querySelector('[data-thread-phase] button')?.getAttribute('aria-label')).toContain('Cate')
  act(() => root.render(<ThreadList entries={entries} open={['ws']} hidden={false} query="no matches" />))
  expect(host.textContent).toContain('No matching threads')
  expect(button('Settled').textContent).toContain('0')
})
