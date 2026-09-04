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
  it('maps the guest cursor through the same display scale without a target box', () => {
    act(() => {
      root.render(<AgentCursorOverlay panelId="browser-1" scale={0.5} />)
      emitAgentCursor('browser-1', {
        kind: 'click',
        x: 80,
        y: 60,
        rect: [20, 30, 100, 40],
        label: 'click',
      })
    })

    const cursor = host.querySelector<HTMLElement>('[data-agent-cursor]')!
    expect(cursor.style.left).toBe('40px')
    expect(cursor.style.top).toBe('30px')
    expect(Array.from(host.querySelectorAll<HTMLElement>('div')).some((element) => (
      element.style.left === '10px'
      && element.style.top === '15px'
      && element.style.width === '50px'
      && element.style.height === '20px'
    ))).toBe(false)
  })

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
    const ripple = host.querySelector<HTMLElement>('[data-agent-effect="click"]')!
    expect(ripple.style.animation).toContain('cate-agent-ripple')
    expect(renderedText()).not.toContain('click')
    expect(renderedText()).not.toContain('@s2e5')
    expect(renderedText()).not.toContain('Agent')
  })

  it('keeps the pointer animation for typing without rendering a target box or entered text', () => {
    act(() => {
      emitAgentCursor('browser-1', {
        kind: 'type',
        x: 60,
        y: 50,
        rect: [25, 35, 120, 30],
        label: 'type "private value"',
      })
    })

    const cursorSvg = host.querySelector<SVGElement>('[data-agent-cursor] svg')!
    expect(cursorSvg.style.animation).toContain('cate-agent-pointer-type')
    expect(host.querySelector('[data-agent-effect="type"]')).toBeNull()
    expect(renderedText()).not.toContain('private value')
  })
})
