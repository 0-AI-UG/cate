import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import ReactMarkdown from 'react-markdown'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import MarkdownCodeBlock from './MarkdownCodeBlock'

const mocks = vi.hoisted(() => ({
  render: vi.fn(), initialize: vi.fn(), loaded: vi.fn(),
  writeText: vi.fn(),
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
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
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
  mocks.writeText.mockReset().mockResolvedValue(undefined)
  vi.stubGlobal('electronAPI', { terminalClipboardWrite: mocks.writeText })
  // Clipboard writes can be unavailable to the browser renderer in Electron.
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
  if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard)
  else Reflect.deleteProperty(navigator, 'clipboard')
})

it('keeps ordinary fenced and inline code without loading Mermaid', async () => {
  await show(fence('const answer = 42', 'js') + '\n\n`mermaid`')
  expect(host.querySelector('pre code')?.textContent).toBe('const answer = 42\n')
  expect(host.querySelector('[role="img"] svg')).toBeNull()
  expect(mocks.loaded).not.toHaveBeenCalled()
})

it('copies the exact code through the native clipboard and waits for success', async () => {
  let finish!: () => void
  mocks.writeText.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
  const source = 'cate panel list\n  echo "Grüße <>&"'
  await show(fence(source, 'sh'))
  const button = host.querySelector('button')!
  await act(async () => button.click())
  expect(mocks.writeText).toHaveBeenCalledWith(source + '\n')
  expect(button.getAttribute('aria-label')).toBe('Copy code')
  await act(async () => finish())
  expect(button.getAttribute('aria-label')).toBe('Copied')
})

it('reports a failed copy and allows retrying', async () => {
  mocks.writeText.mockRejectedValueOnce(new Error('Clipboard unavailable'))
  await show(fence('cate panel list', 'sh'))
  const button = host.querySelector('button')!
  await act(async () => button.click())
  expect(button.getAttribute('aria-label')).toBe('Copy failed. Try again')
  await act(async () => button.click())
  expect(mocks.writeText).toHaveBeenCalledTimes(2)
  expect(button.getAttribute('aria-label')).toBe('Copied')
})

it('renders Mermaid outside pre, keeps copyable source, and skips unchanged diagrams', async () => {
  const source = 'graph LR; A-->B'
  await show('Original prose\n\n' + fence(source))
  expect(host.querySelector('[role="img"] svg')).not.toBeNull()
  expect(host.querySelector('pre svg')).toBeNull()
  expect(mocks.initialize).toHaveBeenCalledWith(expect.objectContaining({ securityLevel: 'strict', startOnLoad: false }))
  await act(async () => (host.querySelector('[aria-label="Copy code"]') as HTMLButtonElement).click())
  expect(mocks.writeText).toHaveBeenCalledWith(source + '\n')
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
