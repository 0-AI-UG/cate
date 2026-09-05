import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { collapsedHunkGaps, ReviewNoteComposer, UnifiedLine } from './ReviewPanel'

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

describe('ReviewNoteComposer', () => {
  it('submits an inline note from the in-panel composer', () => {
    const submit = vi.fn()
    act(() => {
      root.render(
        <ReviewNoteComposer
          draft={{ filePath: 'src/example.ts', side: 'new', line: 42, context: 'return false' }}
          onClose={() => {}}
          onSubmit={submit}
        />,
      )
    })

    const textarea = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Review note"]')!
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      setter?.call(textarea, 'This needs a regression test')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const addButton = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === 'Comment')!
    act(() => addButton.click())

    expect(submit).toHaveBeenCalledWith('This needs a regression test', 'warning')
  })

  it('submits a comment with the chosen severity', () => {
    const submit = vi.fn()
    act(() => {
      root.render(
        <ReviewNoteComposer
          draft={{ filePath: 'src/example.ts', side: 'new', line: 42, context: 'return false' }}
          onClose={() => {}}
          onSubmit={submit}
        />,
      )
    })

    const textarea = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Review note"]')!
    const severity = host.querySelector<HTMLSelectElement>('select[aria-label="Review note severity"]')!
    act(() => {
      const textSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      textSetter?.call(textarea, 'This can corrupt persisted state')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
      const selectSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
      selectSetter?.call(severity, 'error')
      severity.dispatchEvent(new Event('change', { bubbles: true }))
    })
    const commentButton = Array.from(host.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === 'Comment')!
    act(() => commentButton.click())

    expect(submit).toHaveBeenCalledWith('This can corrupt persisted state', 'error')
  })

  it('renders the editor in a comment row attached to the selected diff line', () => {
    act(() => {
      root.render(
        <UnifiedLine
          line={{ kind: 'add', oldLine: null, newLine: 42, text: 'return false' }}
          wordDiff={false}
          notes={[]}
          addNote={() => {}}
          toggleNote={() => {}}
          noteDraft={{ filePath: 'src/example.ts', side: 'new', line: 42, context: 'return false' }}
          submitNote={() => {}}
          cancelNote={() => {}}
        />,
      )
    })

    const editor = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Review note"]')!
    const commentColumn = editor.closest('form')?.parentElement
    expect(commentColumn?.previousElementSibling?.className).toContain('w-[116px]')
    expect(commentColumn?.parentElement?.className).toContain('w-[100cqw]')
    expect(editor.closest('form')?.className).toContain('w-full')
    expect(commentColumn?.parentElement?.previousElementSibling?.textContent).toContain('return false')
  })
})

describe('collapsedHunkGaps', () => {
  it('counts unchanged ranges before and between diff hunks', () => {
    expect(collapsedHunkGaps([
      { header: '@@ -127,6 +127,6 @@', oldStart: 127, oldLines: 6, newStart: 127, newLines: 6, lines: [] },
      { header: '@@ -206,5 +206,5 @@', oldStart: 206, oldLines: 5, newStart: 206, newLines: 5, lines: [] },
    ])).toEqual([126, 73])
  })
})
