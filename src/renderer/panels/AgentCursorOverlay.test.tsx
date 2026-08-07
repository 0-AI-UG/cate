import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emitAgentCursor } from '../lib/browser/agentCursor'
import { AgentCursorOverlay } from './AgentCursorOverlay'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

function renderedText(): string {
  const clone = host.cloneNode(true) as HTMLDivElement
  clone.querySelectorAll('style').forEach((style) => style.remove())
  return clone.textContent ?? ''
}

beforeEach(() => {
  vi.useFakeTimers()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root.render(<AgentCursorOverlay panelId="browser-1" />))
})

afterEach(() => {
  act(() => {
    vi.runAllTimers()
    root.unmount()
  })
  vi.useRealTimers()
  host.remove()
})

describe('AgentCursorOverlay', () => {
  it('renders click feedback without exposing the command label or ref', () => {
    act(() => {
      emitAgentCursor('browser-1', {
        kind: 'click',
        x: 40,
        y: 30,
        rect: [20, 20, 80, 24],
        label: 'click @s2e5',
      })
    })

    expect(host.querySelector('[data-agent-cursor]')).not.toBeNull()
    expect(host.querySelector('[data-agent-effect="click"]')).not.toBeNull()
    expect(renderedText()).not.toContain('click')
    expect(renderedText()).not.toContain('@s2e5')
    expect(renderedText()).not.toContain('Agent')
  })

  it('uses target animation for typing without rendering entered text', () => {
    act(() => {
      emitAgentCursor('browser-1', {
        kind: 'type',
        x: 60,
        y: 50,
        rect: [25, 35, 120, 30],
        label: 'type "private value"',
      })
    })

    expect(host.querySelector('[data-agent-effect="type"]')).not.toBeNull()
    expect(renderedText()).not.toContain('private value')
  })
})
