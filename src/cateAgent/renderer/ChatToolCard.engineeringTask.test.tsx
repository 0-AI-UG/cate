import React from 'react'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { ToolCard } from './ChatToolCard'
import type { ToolMessage } from './codingStore'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

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

describe('ToolCard engineering_task', () => {
  it('uses the standard collapsed row and structured expanded details', () => {
    const msg: ToolMessage = {
      type: 'tool',
      id: 'message-1',
      toolCallId: 'tool-1',
      name: 'engineering_task',
      args: {
        goal: 'Refresh README.md accurately',
        check: 'Run typecheck',
        overview: 'Preserve unrelated work.',
      },
      status: 'success',
      result: 'The user approved the transfer.',
    }

    act(() => root.render(<ToolCard msg={msg} />))

    expect(host.textContent).toContain('Delegated task')
    expect(host.textContent).toContain('Refresh README.md accurately')
    expect(host.textContent).not.toContain('Used engineering_task')

    const button = host.querySelector('button')
    expect(button).not.toBeNull()
    act(() => button!.click())

    expect(host.textContent).toContain('Goal')
    expect(host.textContent).toContain('Verification')
    expect(host.textContent).toContain('Run typecheck')
    expect(host.textContent).toContain('Context')
    expect(host.textContent).toContain('Preserve unrelated work.')
    expect(host.textContent).not.toContain('"goal"')
  })

  it('structures JSON-string arguments too', () => {
    const msg: ToolMessage = {
      type: 'tool',
      id: 'message-2',
      toolCallId: 'tool-2',
      name: 'engineering_task',
      args: JSON.stringify({
        goal: 'Update the public API docs',
        check: 'Verify every documented path',
        overview: 'The repository uses Bun.',
      }),
      status: 'success',
    }

    act(() => root.render(<ToolCard msg={msg} />))

    expect(host.textContent).toContain('Update the public API docs')
    const button = host.querySelector('button')
    act(() => button!.click())
    expect(host.textContent).toContain('Verify every documented path')
    expect(host.textContent).toContain('The repository uses Bun.')
    expect(host.textContent).not.toContain('"overview"')
  })
})
