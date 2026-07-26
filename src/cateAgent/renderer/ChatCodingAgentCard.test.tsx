import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import type { ToolMessage } from './codingStore'
import { useAppStore } from '../../renderer/stores/appStore'
import { CodingAgentCard } from './ChatCodingAgentCard'

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
      prompt: 'Make the default test command deterministic',
      newWorktree: 'dx/deterministic-tests',
    },
    status: 'success',
    result: JSON.stringify({
      id: 'run-1',
      panelId: 'panel-1',
      agentId: 'codex',
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
    useAppStore.setState({
      workspaces: [{
        id: 'workspace-1',
        panels: {
          'panel-1': {
            id: 'panel-1',
            type: 'terminal',
            title: 'Codex 3',
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

  it('renders a flat Cate row with a tab-style terminal chip', () => {
    act(() => root.render(<CodingAgentCard msg={message()} />))

    const row = host.querySelector<HTMLElement>('[data-tool-name="create_coding_agent"]')!
    const terminalLink = host.querySelector<HTMLElement>('[data-coding-agent-terminal-link]')!

    expect(row.className).not.toContain('border')
    expect(row.className).not.toContain('rounded')
    expect(row.className).not.toContain('bg-surface')
    expect(host.querySelector('[aria-label="Cate"]')).not.toBeNull()
    expect(terminalLink.textContent).toContain('Codex')
    expect(terminalLink.className).toContain('rounded-[10px]')
    expect(host.textContent).toContain('Make the default test command deterministic')

    act(() => {
      host.querySelector<HTMLElement>('[aria-label="Show coding agent details"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(host.textContent).toContain('Input')
    expect(host.textContent).toContain('Output')
    expect(host.querySelector('.rounded-md')).toBeNull()
  })
})
