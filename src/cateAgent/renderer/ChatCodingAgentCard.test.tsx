import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import type { ToolMessage } from './codingStore'
import { useAppStore } from '../../renderer/stores/appStore'
import { CodingAgentCard } from './ChatCodingAgentCard'

const reviewCodingAgentWorktree = vi.hoisted(() => vi.fn())
const keepCodingAgentWorktree = vi.hoisted(() => vi.fn())
const terminalStatus = vi.hoisted(() => ({ runStatus: 'starting' as string | null, line: '' }))

vi.mock('../../renderer/lib/agent/codingAgentIntegration', () => ({
  reviewCodingAgentWorktree,
  applyCodingAgentWorktree: vi.fn(),
  discardCodingAgentWorktree: vi.fn(),
  keepCodingAgentWorktree,
}))
vi.mock('./useAgentTerminalStatus', () => ({
  useAgentTerminalStatus: () => terminalStatus,
  codingAgentStatusLabel: (status: string) => status[0].toUpperCase() + status.slice(1),
}))

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const initialAppState = useAppStore.getState()

function message(): ToolMessage {
  return {
    type: 'tool',
    id: 'create-message',
    toolCallId: 'create-call',
    name: 'create_coding_agent',
    args: {
      agentId: 'codex',
      title: 'Test reliability',
      prompt: 'Make the default test command deterministic',
      newWorktree: 'dx/deterministic-tests',
    },
    status: 'success',
    result: JSON.stringify({
      id: 'run-1',
      panelId: 'panel-1',
      agentId: 'codex',
      title: 'Test reliability',
      agentName: 'Codex',
      status: 'starting',
      cwd: '/repo',
      worktreeId: 'worktree-1',
    }),
  }
}

describe('coding agent launch presentation', () => {
  let host: HTMLDivElement
  let root: Root

  beforeEach(() => {
    reviewCodingAgentWorktree.mockReset()
    keepCodingAgentWorktree.mockReset()
    terminalStatus.runStatus = 'starting'
    useAppStore.setState({
      workspaces: [{
        id: 'workspace-1',
        panels: {
          'panel-1': {
            id: 'panel-1',
            type: 'terminal',
            title: 'Test reliability',
            codingAgentRun: {
              id: 'run-1',
              agentId: 'codex',
              title: 'Test reliability',
              panelId: 'panel-1',
              ownerPanelId: 'supervisor-1',
              prompt: 'Make the default test command deterministic',
              createdAt: 1,
            },
          },
        },
      }],
      selectedWorkspaceId: 'workspace-1',
    } as never)
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    useAppStore.setState(initialAppState, true)
  })

  it('renders the canonical terminal title with tab-style presentation', () => {
    act(() => root.render(<CodingAgentCard msg={message()} />))

    const row = host.querySelector<HTMLElement>('[data-tool-name="create_coding_agent"]')!
    const terminalLink = host.querySelector<HTMLElement>('[data-coding-agent-terminal-link]')!

    expect(row.className).not.toContain('border')
    expect(row.className).not.toContain('rounded')
    expect(row.className).not.toContain('bg-surface')
    expect(host.querySelector('[aria-label="Cate"]')).not.toBeNull()
    expect(terminalLink.textContent).toBe('Test reliability')
    expect(terminalLink.className).not.toContain('rounded')
    expect(terminalLink.className).not.toContain('bg-surface')
    expect(host.textContent).not.toContain('Make the default test command deterministic')

    act(() => {
      host.querySelector<HTMLElement>('[aria-label="Show coding agent details"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(host.textContent).toContain('Input')
    expect(host.textContent).toContain('Output')
    expect(host.textContent).toContain('Make the default test command deterministic')
    expect(host.querySelector('.rounded-md')).toBeNull()
  })

  it('shows a non-zero worker exit as failed instead of finished', () => {
    terminalStatus.runStatus = 'failed'
    useAppStore.getState().setPanelCodingAgentRun('workspace-1', 'panel-1', {
      id: 'run-1',
      agentId: 'codex',
      panelId: 'panel-1',
      ownerPanelId: 'supervisor-1',
      prompt: 'Make the default test command deterministic',
      createdAt: 1,
      endedAt: 2,
      exitCode: 1,
    })

    act(() => root.render(<CodingAgentCard msg={message()} />))

    const terminalLink = host.querySelector<HTMLElement>('[data-coding-agent-terminal-link]')
    expect(terminalLink?.title).toContain('Failed')
  })

  it('uses the same title shimmer class as terminal tabs while the worker runs', () => {
    terminalStatus.runStatus = 'working'

    act(() => root.render(<CodingAgentCard msg={message()} />))

    const title = host.querySelector<HTMLElement>('[data-coding-agent-terminal-link] .cate-notif-pulse')
    expect(title?.textContent).toBe('Test reliability')
  })

  it('offers review, apply, keep, and discard when an isolated worker finishes', async () => {
    terminalStatus.runStatus = 'ready'
    reviewCodingAgentWorktree.mockResolvedValue({
      branch: 'agent/tests',
      baseBranch: 'main',
      dirty: false,
      canApply: true,
      commits: [{ hash: 'abcdef123', message: 'Add deterministic tests' }],
      files: [{ status: 'M', path: 'tests.ts' }],
      workingFiles: [],
      diff: 'diff --git a/tests.ts b/tests.ts',
      truncated: false,
    })
    useAppStore.getState().setPanelCodingAgentRun('workspace-1', 'panel-1', {
      id: 'run-1',
      agentId: 'codex',
      title: 'Test reliability',
      panelId: 'panel-1',
      ownerPanelId: 'supervisor-1',
      prompt: 'Make the default test command deterministic',
      createdAt: 1,
      endedAt: 2,
      exitCode: 0,
      worktreeId: 'worktree-1',
      ownsWorktree: true,
    })

    await act(async () => root.render(<CodingAgentCard msg={message()} />))

    expect(host.textContent).toContain('Review changes')
    expect(host.textContent).toContain('Apply to main')
    expect(host.textContent).toContain('Keep worktree')
    expect(host.textContent).toContain('Discard')

    const keep = Array.from(host.querySelectorAll('button'))
      .find((button) => button.textContent === 'Keep worktree')!
    act(() => keep.click())
    expect(keepCodingAgentWorktree).toHaveBeenCalledWith('workspace-1', 'panel-1')
  })
})
