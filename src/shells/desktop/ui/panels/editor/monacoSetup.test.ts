import { expect, it, vi } from 'vitest'
import type { Theme } from '@kernel/interaction/contract'
import { applyMonacoTheme, monaco, CATE_MONACO_THEME } from './monacoSetup'

vi.mock('monaco-editor', () => ({ editor: { defineTheme: vi.fn(), setTheme: vi.fn() } }))

it('applies a shared editor theme once across mounts, but applies changed themes and switching back', () => {
  const first = { editor: { base: 'vs-dark', tokens: [{ token: 'comment', foreground: 'aaaaaa' }], colors: { 'editor.background': '#101010' } } } as unknown as Theme
  applyMonacoTheme(first)
  applyMonacoTheme(first)
  applyMonacoTheme({ ...first })
  expect(monaco.editor.defineTheme).toHaveBeenCalledTimes(1)
  expect(monaco.editor.setTheme).toHaveBeenCalledTimes(1)
  const second = { ...first, editor: { ...first.editor, colors: { 'editor.background': '#ffffff' } } }
  applyMonacoTheme(second)
  expect(monaco.editor.defineTheme).toHaveBeenLastCalledWith(CATE_MONACO_THEME, expect.objectContaining({ colors: second.editor.colors }))
  expect(monaco.editor.setTheme).toHaveBeenCalledTimes(2)
  applyMonacoTheme(first)
  expect(monaco.editor.defineTheme).toHaveBeenCalledTimes(3)
  expect(monaco.editor.setTheme).toHaveBeenCalledTimes(3)
})
