import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import type { ToolMessage } from './codingStore'
import {
  OrchestrationToolCard,
  orchestrationToolSummary,
} from './ChatOrchestrationToolCard'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function message(
  name: string,
  args: unknown,
  result?: unknown,
  status: ToolMessage['status'] = 'success',
): ToolMessage {
  return {
    type: 'tool',
    id: `message-${name}`,
    toolCallId: `call-${name}`,
    name,
    args,
    status,
    ...(result === undefined ? {} : { result: JSON.stringify(result, null, 2) }),
  }
}

describe('orchestration tool presentation', () => {
  let host: HTMLDivElement
  let root: Root

  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  it('uses contextual summaries instead of the generic Used label', () => {
    expect(orchestrationToolSummary(message(
      'send_to_coding_agent',
      { runId: '12345678-abcd', prompt: 'Run the focused tests' },
      { agentName: 'Codex', status: 'working' },
    ))).toEqual({
      verb: 'Steered',
      detail: 'Codex · Run the focused tests',
    })

    expect(orchestrationToolSummary(message(
      'wait_for_coding_agents',
      { runIds: ['one'], timeoutSeconds: 60 },
      { timedOut: true, runs: [{ id: 'one', status: 'working' }] },
    ))).toEqual({
      verb: 'Monitored',
      detail: '1 coding agent · no change after 60s',
    })

    expect(orchestrationToolSummary(message(
      'wait_for_coding_agents',
      { runIds: ['one'] },
      {
        timedOut: false,
        changedRunIds: ['one'],
        runs: [{ id: 'one', agentName: 'Codex', status: 'waiting' }],
      },
    ))).toEqual({
      verb: 'Agent update',
      detail: 'Codex · waiting',
    })
  })

  it('reveals structured tool input and output from its collapsed summary', () => {
    const msg = message(
      'inspect_coding_agent',
      { runId: 'run-1' },
      { agentName: 'Codex', status: 'ready', recentOutput: 'All tests passed' },
    )
    act(() => root.render(<OrchestrationToolCard msg={msg} />))

    expect(host.textContent).toContain('Inspected')
    expect(host.textContent).not.toContain('recentOutput')

    act(() => {
      host.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(host.textContent).toContain('Input')
    expect(host.textContent).toContain('Run')
    expect(host.textContent).toContain('run-1')
    expect(host.textContent).toContain('Output')
    expect(host.textContent).toContain('Codex')
    expect(host.textContent).toContain('ready')
    expect(host.textContent).toContain('Terminal output')
    expect(host.textContent).toContain('All tests passed')
    expect(host.textContent).not.toContain('"runId"')
    expect(host.textContent).not.toContain('"recentOutput"')
    expect(host.querySelector('.rounded-md')).toBeNull()
  })

  it('renders legacy wait results without exposing their raw prompt payload', () => {
    const msg = message(
      'wait_for_coding_agents',
      {
        runIds: ['fae0053c-7710-43cf-8767-66304ab47e91'],
        timeoutSeconds: 8,
      },
      {
        timedOut: true,
        runs: [{
          id: 'fae0053c-7710-43cf-8767-66304ab47e91',
          agentId: 'codex',
          panelId: '16dbc81e-ad5b-4ae2-b373-7df2861b26ae',
          prompt: 'Mission: noisy legacy prompt that should stay hidden',
          createdAt: 1_786_000_000_000,
          status: 'working',
          agentName: 'Codex',
          cwd: '/repo',
          alive: true,
          followUpSupported: true,
          statusLine: 'Running tests',
        }],
      },
    )
    act(() => root.render(<OrchestrationToolCard msg={msg} />))

    act(() => {
      host.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(host.textContent).toContain('Targets')
    expect(host.textContent).toContain('8 seconds')
    expect(host.textContent).toContain('No meaningful state change before timeout')
    expect(host.textContent).toContain('Codex')
    expect(host.textContent).toContain('working')
    expect(host.textContent).toContain('/repo')
    expect(host.textContent).toContain('Running tests')
    expect(host.textContent).not.toContain('Mission: noisy legacy prompt')
    expect(host.textContent).not.toContain('"timedOut"')
    expect(host.textContent).not.toContain('"prompt"')
    expect(host.querySelector('.rounded-md')).toBeNull()
  })
})
