import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import ReactMarkdown from 'react-markdown'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import MarkdownCodeBlock from './MarkdownCodeBlock'

const mocks = vi.hoisted(() => ({
  render: vi.fn(), initialize: vi.fn(), loaded: vi.fn(),
  themeChanged: null as null | ((theme: { type: string }) => void),
}))
vi.mock('mermaid', () => {
  mocks.loaded()
  return { default: { render: mocks.render, initialize: mocks.initialize } }
})
vi.mock('../lib/themeManager', () => ({
  getActiveTheme: () => ({ type: 'dark' }),
  subscribeTheme: (callback: typeof mocks.themeChanged) => {
    mocks.themeChanged = callback
    return () => { mocks.themeChanged = null }
  },
}))
vi.mock('../ui/Tooltip', () => ({ Tooltip: ({ children }: any) => children }))

let host: HTMLDivElement
let root: Root
const fence = (source: string, language = 'mermaid') => `\`\`\`${language}\n${source}\n\`\`\``
async function show(content: string) {
  await act(async () => root.render(<ReactMarkdown components={{ pre: MarkdownCodeBlock }}>{content}</ReactMarkdown>))
}
beforeEach(() => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  mocks.render.mockReset().mockResolvedValue({ svg: '<svg><text>Diagram</text></svg>' })
  mocks.initialize.mockClear()
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

it('keeps ordinary fenced and inline code without loading Mermaid', async () => {
  await show(fence('const answer = 42', 'js') + '\n\n`mermaid`')
  expect(host.querySelector('pre code')?.textContent).toBe('const answer = 42\n')
  expect(host.querySelector('[role="img"] svg')).toBeNull()
  expect(mocks.loaded).not.toHaveBeenCalled()
})

it('renders Mermaid outside pre, keeps copyable source, and skips unchanged diagrams', async () => {
  const source = 'graph LR; A-->B'
  await show('Original prose\n\n' + fence(source))
  expect(host.querySelector('[role="img"] svg')).not.toBeNull()
  expect(host.querySelector('pre svg')).toBeNull()
  expect(mocks.initialize).toHaveBeenCalledWith(expect.objectContaining({ securityLevel: 'strict', startOnLoad: false }))
  const writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  await act(async () => (host.querySelector('[aria-label="Copy code"]') as HTMLButtonElement).click())
  expect(writeText).toHaveBeenCalledWith(source + '\n')
  await show('Changed prose\n\n' + fence(source))
  expect(mocks.render).toHaveBeenCalledTimes(1)
})

it('falls back to source on errors and recovers after edits', async () => {
  mocks.render.mockRejectedValueOnce(new Error('Syntax error'))
  await show(fence('invalid diagram'))
  expect(host.querySelector('[role="status"]')?.textContent).toContain('Unable to render')
  expect(host.querySelector('pre')?.textContent).toContain('invalid diagram')
  await show(fence('graph LR; A-->B'))
  expect(host.querySelector('[role="img"] svg')).not.toBeNull()
})

it('ignores stale renders and serializes multiple blocks with unique IDs', async () => {
  let finish!: (result: { svg: string }) => void
  mocks.render.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  await show(fence('graph LR; Old-->Value'))
  await show(fence('graph LR; New-->Value') + '\n\n' + fence('sequenceDiagram\nA->>B: Hello'))
  expect(mocks.render).toHaveBeenCalledTimes(1)
  await act(async () => finish({ svg: '<svg><text>Stale</text></svg>' }))
  expect(host.textContent).not.toContain('Stale')
  expect(host.querySelectorAll('[role="img"] svg')).toHaveLength(2)
  expect(new Set(mocks.render.mock.calls.map(call => call[0])).size).toBe(3)
  await act(async () => mocks.themeChanged?.({ type: 'light' }))
  expect(mocks.initialize).toHaveBeenLastCalledWith(expect.objectContaining({ theme: 'default' }))
})
