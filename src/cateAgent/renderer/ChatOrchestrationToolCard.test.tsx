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

  it('reveals the complete tool input and output from its collapsed summary', () => {
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
    expect(host.textContent).toContain('"runId": "run-1"')
    expect(host.textContent).toContain('Output')
    expect(host.textContent).toContain('"recentOutput": "All tests passed"')
  })
})
