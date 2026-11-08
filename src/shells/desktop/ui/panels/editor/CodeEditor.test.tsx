import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { CodeEditor } from './CodeEditor'
import { monaco } from './monacoSetup'

const state = vi.hoisted(() => ({ theme: { editor: { base: 'vs-dark', tokens: [], colors: {} } }, listeners: new Set<(theme: unknown) => void>(), editors: [] as { updateOptions: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }[] }))
vi.mock('../../kernel/interaction', () => ({
  getActiveTheme: () => state.theme,
  subscribeTheme: (callback: (theme: unknown) => void) => { state.listeners.add(callback); return () => state.listeners.delete(callback) },
}))
vi.mock('y-monaco', () => ({ MonacoBinding: class {} }))
vi.mock('monaco-editor', () => ({ editor: {
  defineTheme: vi.fn(), setTheme: vi.fn(), remeasureFonts: vi.fn(),
  create: vi.fn(() => {
    const editor = { updateOptions: vi.fn(), dispose: vi.fn(), layout: vi.fn() }
    state.editors.push(editor)
    return editor
  }),
} }))

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let container: HTMLDivElement
let root: ReturnType<typeof createRoot>
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  state.editors.length = 0
  container = document.createElement('div'); document.body.append(container)
  root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals() })

it('mounts multiple editors without global font-cache flushes and preserves real font/theme updates', () => {
  const font = { fontFamily: 'Menlo', fontSize: 14 }
  const render = (count: number, currentFont = font) => act(() => root.render(<>{Array.from({ length: count }, (_, i) => <CodeEditor key={i} panelId={`p${i}`} filePath="file.ts" text={null} font={currentFont} />)}</>))
  render(1); render(2)
  expect(monaco.editor.defineTheme).toHaveBeenCalledTimes(1)
  expect(monaco.editor.setTheme).toHaveBeenCalledTimes(1)
  expect(monaco.editor.remeasureFonts).not.toHaveBeenCalled()
  expect(state.editors[0].updateOptions).not.toHaveBeenCalled()
  expect(state.editors[1].updateOptions).not.toHaveBeenCalled()
  const nextFont = { fontFamily: 'Monaco', fontSize: 16 }
  render(2, nextFont)
  for (const editor of state.editors) expect(editor.updateOptions).toHaveBeenLastCalledWith(nextFont)
  expect(monaco.editor.remeasureFonts).toHaveBeenCalledTimes(2)
  render(2, { ...nextFont })
  expect(monaco.editor.remeasureFonts).toHaveBeenCalledTimes(2)
  state.theme = { editor: { ...state.theme.editor, colors: { 'editor.background': '#ffffff' } } }
  act(() => { for (const listener of state.listeners) listener(state.theme) })
  expect(monaco.editor.defineTheme).toHaveBeenCalledTimes(2)
  expect(monaco.editor.setTheme).toHaveBeenCalledTimes(2)
})
